const fs = require('fs');
const path = require('path');

const { chat, LANG_NAMES } = require('./guionLargo');
const { llamarOpenAIImagen, llamarGoogleImagen } = require('./imagenes');
const { renderPrompt } = require('../utils/prompts');

const DIR_PROMPTS = path.join(__dirname, '..', 'prompts', 'largo');
const ESCENAS_POR_LOTE = 12;
const CONCURRENCIA_LOTES = 3;
// Spacing throttles the rate; concurrency only caps in-flight requests (each takes 15–40 s).
const CONCURRENCIA_IMAGENES = 4;
const segEntre = parseFloat(process.env.LARGO_SEGUNDOS_ENTRE_IMAGENES);
const MS_ENTRE_IMAGENES = (isNaN(segEntre) ? 10 : Math.min(60, Math.max(0, segEntre))) * 1000;
const INTENTOS_IMAGEN = 5;
const BACKOFF_BASE_MS = 15000;
const BACKOFF_MAX_MS = 90000;
const PAUSA_RESCATE_MS = 60000;
const MAX_CHARS_TEXTO = 60;
// Por debajo de esta fracción del objetivo, la última escena de una sección se funde con la anterior
const FRACCION_MINIMA = 0.4;

const FORMATOS = {
  horizontal: { composicion: 'Horizontal 16:9 composition.', google: '16:9', openai: '1536x1024', ancho: 1920, alto: 1080, fuente: 64, margenV: 70, margenH: 160 },
  vertical:   { composicion: 'Vertical 9:16 composition.',   google: '9:16', openai: '1024x1536', ancho: 1080, alto: 1920, fuente: 72, margenV: 260, margenH: 80 },
};
const formatoDe = orientacion => FORMATOS[orientacion] || FORMATOS.horizontal;

const leerPrompt = nombre => fs.readFileSync(path.join(DIR_PROMPTS, nombre), 'utf-8');

async function ejecutarConLimite(tareas, limite) {
  let siguiente = 0;
  const trabajadores = Array.from({ length: Math.min(limite, tareas.length) }, async () => {
    while (siguiente < tareas.length) {
      const i = siguiente++;
      await tareas[i]();
    }
  });
  await Promise.all(trabajadores);
}

/**
 * Agrupa la línea de tiempo por oraciones en escenas de ~segundosObjetivo sin cruzar secciones.
 * Las escenas resultantes cubren el audio completo sin huecos.
 */
function agruparEscenas(segmentos, segundosObjetivo, duracionTotal) {
  const escenas = [];
  let actual = null;
  for (const seg of segmentos) {
    const cerrar = !actual
      || seg.seccion !== actual.seccion
      || (seg.fin - actual.inicio > segundosObjetivo && seg.inicio - actual.inicio >= segundosObjetivo * 0.5);
    if (cerrar) {
      actual = { seccion: seg.seccion, inicio: seg.inicio, fin: seg.fin, segmentos: [] };
      escenas.push(actual);
    }
    actual.segmentos.push(seg);
    actual.fin = seg.fin;
  }

  for (let i = escenas.length - 1; i > 0; i--) {
    const e = escenas[i];
    const prev = escenas[i - 1];
    const esUltimaDeSeccion = !escenas[i + 1] || escenas[i + 1].seccion !== e.seccion;
    if (esUltimaDeSeccion && prev.seccion === e.seccion && e.fin - e.inicio < segundosObjetivo * FRACCION_MINIMA) {
      prev.segmentos.push(...e.segmentos);
      prev.fin = e.fin;
      escenas.splice(i, 1);
    }
  }

  return escenas.map((e, i) => ({
    n: i + 1,
    seccion: e.seccion,
    inicio: i === 0 ? 0 : e.segmentos[0].inicio,
    fin: i === escenas.length - 1 ? duracionTotal : escenas[i + 1].segmentos[0].inicio,
    texto: e.segmentos.map(s => (s.voz ? `${s.voz}: ` : '') + s.texto).join(' '),
  }));
}

async function generarGuiaEstilo({ titulo, tema, idioma, nivel, formato, secciones }) {
  const personajes = formato === 'dialogo'
    ? 'two recurring characters that appear in most scenes: "F", a female teacher who explains, and "M", a male learner who asks and practices. Describe both precisely (age, hair, clothing, colors) so they look identical in every image.'
    : 'optionally one recurring teacher/guide character; describe precisely if used.';
  const prompt = renderPrompt(leerPrompt('director-estilo.txt'), {
    titulo, tema, nivel,
    idioma: LANG_NAMES[idioma],
    formato: formato === 'dialogo' ? 'two-voice dialogue' : 'single narrator',
    secciones: secciones.map((s, i) => `${i + 1}. ${s.titulo}`).join('\n'),
    personajes,
  });
  const guia = JSON.parse(await chat(prompt, { maxTokens: 800, temperature: 0.5, json: true }));
  if (!guia.estilo) throw new Error('El director de arte no devolvió una guía de estilo.');
  return { estilo: String(guia.estilo), personajes: String(guia.personajes || '') };
}

function textoGuia(guia) {
  return guia.personajes ? `${guia.estilo}\nRecurring characters: ${guia.personajes}` : guia.estilo;
}

/** ASS usa llaves y barra invertida como marcado; se neutralizan. */
function limpiarTextoPantalla(texto) {
  return String(texto || '').replace(/[{}\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS_TEXTO);
}

async function dirigirLote(lote, guia, { titulo, idioma, formato }) {
  const prompt = renderPrompt(leerPrompt('director-escenas.txt'), {
    titulo,
    idioma: LANG_NAMES[idioma],
    guia: textoGuia(guia),
    cantidad: lote.length,
    formatoNota: formato === 'dialogo' ? 'F = female teacher, M = male learner' : 'single narrator',
    escenas: lote.map((e, i) => `Scene ${i + 1}:\n"""${e.texto}"""`).join('\n\n'),
  });
  const resp = JSON.parse(await chat(prompt, { maxTokens: 400 * lote.length, temperature: 0.7, json: true }));
  const items = Array.isArray(resp.escenas) ? resp.escenas : [];
  lote.forEach((e, i) => {
    const item = items.find(it => Number(it.n) === i + 1) || items[i] || {};
    e.prompt = String(item.prompt || '').trim()
      || `A scene illustrating this part of the lesson: ${e.texto.slice(0, 300)}`;
    e.textoPantalla = limpiarTextoPantalla(item.texto);
  });
}

/**
 * Paso agéntico: define la guía de estilo del video y un prompt + texto en pantalla por escena.
 * Muta cada escena añadiendo { prompt, textoPantalla }.
 */
async function dirigirArte(escenas, ctx) {
  const guia = await generarGuiaEstilo(ctx);
  const lotes = [];
  for (let i = 0; i < escenas.length; i += ESCENAS_POR_LOTE) lotes.push(escenas.slice(i, i + ESCENAS_POR_LOTE));
  await ejecutarConLimite(lotes.map(lote => () => dirigirLote(lote, guia, ctx)), CONCURRENCIA_LOTES);
  return guia;
}

function componerPrompt(guia, escena, orientacion) {
  return `${textoGuia(guia)}

Scene: ${escena.prompt}

Strict rules: absolutely no text, letters, words, numbers, labels or logos anywhere in the image. ${formatoDe(orientacion).composicion} Keep the bottom fifth of the frame visually calm, a caption will be overlaid there.`;
}

const esperar = ms => new Promise(r => setTimeout(r, ms));

// Image APIs enforce per-minute quotas (429); retrying immediately just hits the same wall.
function esTransitorio(err) {
  const m = err.message || '';
  return /HTTP (429|5\d\d|undefined)/.test(m) || /rate|quota|timeout|ECONN|ETIMEDOUT|socket/i.test(m);
}

function esBloqueoContenido(err) {
  return /filtro de seguridad|moderation|safety|content_policy/i.test(err.message || '');
}

async function generarEscena(e, guia, generar, ruta, orientacion) {
  let prompt = componerPrompt(guia, e, orientacion);
  for (let intento = 1; intento <= INTENTOS_IMAGEN; intento++) {
    try {
      fs.writeFileSync(ruta, await generar(prompt));
      e.imagen = ruta;
      delete e.errorImagen;
      return;
    } catch (err) {
      e.errorImagen = err.message.slice(0, 300);
      console.error(`[escenasLargo] escena ${e.n} intento ${intento}: ${err.message}`);
      if (esBloqueoContenido(err)) {
        // Fall back to the style guide alone: the scene prompt is what usually trips the filter.
        prompt = `${guia.estilo}\n\nScene: a calm, neutral classroom or study setting that fits the lesson mood.\n\nNo text, letters or logos. ${formatoDe(orientacion).composicion}`;
      } else if (!esTransitorio(err)) {
        return;
      }
      if (intento < INTENTOS_IMAGEN) {
        const base = esTransitorio(err) ? BACKOFF_BASE_MS * 2 ** (intento - 1) : 2000;
        await esperar(Math.min(base, BACKOFF_MAX_MS) + Math.random() * 3000);
      }
    }
  }
}

/**
 * Genera una imagen por escena con backoff ante límites de cuota y una pasada de rescate
 * secuencial para las fallidas. Lo que siga fallando reutiliza la imagen vecina.
 */
async function generarImagenesEscenas(escenas, guia, { apiImagen, modeloImagen, dir, orientacion, calidad = 'medium' }, onProgreso) {
  const formato = formatoDe(orientacion);
  fs.mkdirSync(dir, { recursive: true });
  // Reserves start slots synchronously, so concurrent workers and retries share one timeline.
  let proximoInicio = 0;
  const generar = async prompt => {
    const ahora = Date.now();
    const inicio = Math.max(ahora, proximoInicio);
    proximoInicio = inicio + MS_ENTRE_IMAGENES;
    if (inicio > ahora) await esperar(inicio - ahora);
    return apiImagen === 'google'
      ? llamarGoogleImagen(prompt, modeloImagen, formato.google)
      : llamarOpenAIImagen(prompt, modeloImagen, calidad, formato.openai);
  };
  const rutaDe = e => path.join(dir, `escena-${String(e.n).padStart(3, '0')}.png`);

  let hechos = 0;
  await ejecutarConLimite(escenas.map(e => async () => {
    await generarEscena(e, guia, generar, rutaDe(e), orientacion);
    hechos++;
    if (onProgreso) onProgreso(hechos, escenas.length);
  }), CONCURRENCIA_IMAGENES);

  const pendientes = escenas.filter(e => !e.imagen);
  if (pendientes.length) {
    console.warn(`[escenasLargo] rescate: ${pendientes.length} escenas fallidas, reintentando en serie`);
    await esperar(PAUSA_RESCATE_MS);
    for (const e of pendientes) await generarEscena(e, guia, generar, rutaDe(e), orientacion);
  }

  const conImagen = escenas.filter(e => e.imagen);
  if (!conImagen.length) throw new Error('No se pudo generar ninguna imagen de escena.');
  escenas.forEach((e, i) => {
    if (e.imagen) return;
    e.imagen = (escenas.slice(0, i).reverse().find(x => x.imagen) || conImagen[0]).imagen;
    e.imagenReutilizada = true;
  });
}

function tiempoAss(seg) {
  const cs = Math.max(0, Math.round(seg * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/** Escribe el archivo ASS con el texto clave de cada escena (caja semitransparente abajo al centro). */
function escribirAss(escenas, rutaAss, orientacion) {
  const { ancho, alto, fuente, margenV, margenH } = formatoDe(orientacion);
  const eventos = escenas
    .filter(e => e.textoPantalla && e.fin - e.inicio > 1.5)
    .map(e => `Dialogue: 0,${tiempoAss(e.inicio + 0.4)},${tiempoAss(e.fin - 0.3)},Clave,,0,0,0,,{\\fad(300,300)}${e.textoPantalla}`);

  const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: ${ancho}
PlayResY: ${alto}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Clave,Arial,${fuente},&H00FFFFFF,&H00FFFFFF,&H60000000,&H60000000,1,0,0,0,100,100,0,0,3,20,0,2,${margenH},${margenH},${margenV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${eventos.join('\n')}
`;
  fs.writeFileSync(rutaAss, ass, 'utf-8');
  return eventos.length;
}

module.exports = { agruparEscenas, dirigirArte, generarImagenesEscenas, escribirAss, FORMATOS };
