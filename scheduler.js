const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const { escribirJsonAtomico } = require('./utils/archivos');
const { ts } = require('./utils/log');
const { cola } = require('./lib/cola');
const { resolverOpcionesYoutube } = require('./lib/opcionesYoutube');
const { listarNichos, cargarNicho } = require('./services/nichos');
const ideas = require('./services/ideas');
const { obtenerTendencia } = require('./services/tendencias');
const { enviarTexto } = require('./services/telegram');
const { limpiarOutput, diasRetencion } = require('./services/retencion');
const pipelineShort = require('./pipelines/short');

const RUTA_ESTADO = path.join(__dirname, 'scheduler-estado.json');
const CRON_RETENCION = '30 3 * * *';
const RETRASO_RECUPERACION_MS = 60_000;

const config = () => ({
  habilitado: process.env.SCHEDULER_ENABLED === 'true',
  cron: process.env.SCHEDULER_CRON || '0 9 * * *',
  tz: process.env.SCHEDULER_TZ || 'America/Mexico_City',
});

let tarea = null;
let enCurso = false;

function leerEstado() {
  try { return JSON.parse(fs.readFileSync(RUTA_ESTADO, 'utf-8')); } catch { return {}; }
}

function guardarEstado(cambios) {
  escribirJsonAtomico(RUTA_ESTADO, { ...leerEstado(), ...cambios });
}

/** YYYY-MM-DD of a date in the given time zone. */
const diaEn = (fecha, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(fecha);

async function avisar(texto) {
  try { await enviarTexto(texto); } catch (err) { console.error(`[${ts()}] Scheduler: aviso a Telegram falló: ${err.message}`); }
}

/** Upload options: CSV channel, else niche `youtube.canal`; an unknown/unauthorized channel means no upload. */
function opcionesYoutube(idea, nichoConfig) {
  const canal = idea.canal || nichoConfig.youtube?.canal || null;
  if (!canal) return { opciones: resolverOpcionesYoutube({}), aviso: null };
  try {
    return { opciones: resolverOpcionesYoutube({ subirYoutube: true, canalYoutube: canal, privacidadYoutube: 'unlisted' }), aviso: null };
  } catch (err) {
    return { opciones: resolverOpcionesYoutube({}), aviso: `YouTube: ${err.message} Se genera sin subir.` };
  }
}

/**
 * One automated run: pick idea → optional trend → short pipeline (through the queue) → mark idea used.
 * The idea is only marked as used if the pipeline succeeds; failures are reported to Telegram.
 * @returns {Promise<{ ok: boolean, motivo?: string, id?: string }>}
 */
async function ejecutarAhora(origen = 'cron') {
  if (enCurso) return { ok: false, motivo: 'Ya hay una ejecución automática en curso.' };
  enCurso = true;
  const { tz } = config();
  const inicio = new Date();
  guardarEstado({ ultimoIntento: { fecha: inicio.toISOString(), dia: diaEn(inicio, tz), origen } });

  let idea = null;
  let id = null;
  try {
    const nichosValidos = new Set(listarNichos().map(n => n.id));
    idea = ideas.seleccionarIdea({ nichosValidos });
    if (!idea) {
      await avisar('⚠️ Scheduler: no hay ideas válidas en ideas.csv; no se generó el video del día.');
      guardarEstado({ ultimaEjecucion: { fecha: new Date().toISOString(), ok: false, error: 'Sin ideas' } });
      return { ok: false, motivo: 'Sin ideas válidas en ideas.csv.' };
    }

    const nichoConfig = cargarNicho(idea.nicho);
    const contexto = await obtenerTendencia(idea.idea_base, nichoConfig);
    const { opciones: youtube, aviso } = opcionesYoutube(idea, nichoConfig);
    if (aviso) console.warn(`[${ts()}] Scheduler: ${aviso}`);

    id = uuidv4();
    const params = pipelineShort.construirParams({
      id, tema: idea.idea_base, nicho: idea.nicho, nichoConfig, contexto: contexto || null, youtube,
    });
    console.log(`\n[${ts()}] === SCHEDULER (${origen}) id=${id} nicho=${idea.nicho} idea="${idea.idea_base}" tendencia=${contexto ? `"${contexto}"` : 'no'} youtube=${youtube.canalYoutube || 'no'} ===`);

    const emit = (evento, datos) => {
      if (evento === 'en_cola') console.log(`[${ts()}] Scheduler [${id}]: en cola, posición ${datos.posicion}`);
    };
    const resultado = await pipelineShort.ejecutar(params, emit);

    ideas.marcarUsada(idea);
    guardarEstado({ ultimaEjecucion: { fecha: new Date().toISOString(), ok: true, id, nicho: idea.nicho, tema: idea.idea_base, contexto, youtubeUrl: resultado.youtubeUrl || null } });
    await avisar([
      `✅ Video automático generado (${nichoConfig.nombre})`,
      `Idea: ${idea.idea_base}`,
      resultado.youtubeUrl ? `YouTube (no listado): ${resultado.youtubeUrl}` : 'Sin subida a YouTube.',
      aviso || '',
    ].filter(Boolean).join('\n'));
    return { ok: true, id };
  } catch (err) {
    const mensaje = err?.message || String(err);
    console.error(`[${ts()}] Scheduler ERROR:`, mensaje);
    guardarEstado({ ultimaEjecucion: { fecha: new Date().toISOString(), ok: false, id, nicho: idea?.nicho, tema: idea?.idea_base, error: mensaje } });
    await avisar(`⚠️ Scheduler: falló el video automático${idea ? ` (${idea.nicho}: ${idea.idea_base})` : ''}.\nError: ${mensaje.slice(0, 500)}\nLa idea no se marcó como usada.`);
    return { ok: false, motivo: mensaje, id };
  } finally {
    enCurso = false;
  }
}

/**
 * If today's slot already passed (the next run is not today) and nothing was attempted today,
 * runs once. Failed attempts are not retried automatically, so a crash loop never multiplies costs.
 */
function recuperarPerdida() {
  const { tz } = config();
  const hoy = diaEn(new Date(), tz);
  const siguiente = tarea?.getNextRun();
  if (!siguiente || diaEn(siguiente, tz) === hoy) return;
  if (leerEstado().ultimoIntento?.dia === hoy) return;
  console.log(`[${ts()}] Scheduler: ejecución de hoy (${hoy}) perdida, se recupera ahora.`);
  ejecutarAhora('recuperacion').catch(() => {});
}

function ejecutarRetencion() {
  const dias = diasRetencion();
  if (!dias) return;
  const idsActivos = new Set([...cola.idsActivos(), ...pipelineShort.idsEnPausa()]);
  const r = limpiarOutput({ dias, idsActivos });
  console.log(`[${ts()}] Retención: ${r.borrados} elemento(s) de más de ${dias} días borrados (${(r.bytes / 1e6).toFixed(1)} MB), ${r.errores} error(es).`);
}

/** Starts the daily generation (only with SCHEDULER_ENABLED=true) and the output retention job. */
function iniciar() {
  const { habilitado, cron: expr, tz } = config();
  let tzValida = true;
  try { diaEn(new Date(), tz); } catch { tzValida = false; }

  if (diasRetencion()) {
    cron.schedule(CRON_RETENCION, ejecutarRetencion, { timezone: tzValida ? tz : 'UTC', name: 'retencion-output' });
    setTimeout(ejecutarRetencion, RETRASO_RECUPERACION_MS).unref();
    console.log(`[scheduler] Retención de output/ activa: ${diasRetencion()} días.`);
  }

  if (!habilitado) return;
  if (!cron.validate(expr)) {
    console.error(`[scheduler] SCHEDULER_CRON inválido ("${expr}"); scheduler desactivado.`);
    return;
  }
  if (!tzValida) {
    console.error(`[scheduler] SCHEDULER_TZ inválida ("${tz}"); scheduler desactivado.`);
    return;
  }

  tarea = cron.schedule(expr, () => { ejecutarAhora('cron').catch(() => {}); }, { timezone: tz, name: 'video-diario' });
  console.log(`[scheduler] Activo: "${expr}" (${tz}). Próxima ejecución: ${tarea.getNextRun()?.toISOString()}`);
  setTimeout(recuperarPerdida, RETRASO_RECUPERACION_MS).unref();
}

function estado() {
  const { habilitado, cron: expr, tz } = config();
  const e = leerEstado();
  return {
    habilitado,
    activo: Boolean(tarea),
    cron: expr,
    tz,
    proximaEjecucion: tarea?.getNextRun()?.toISOString() || null,
    enCurso,
    ultimoIntento: e.ultimoIntento || null,
    ultimaEjecucion: e.ultimaEjecucion || null,
    cola: cola.estado(),
    ideas: ideas.resumen(),
    retencionDias: diasRetencion(),
  };
}

module.exports = { iniciar, ejecutarAhora, estado, recuperarPerdida, diaEn };
