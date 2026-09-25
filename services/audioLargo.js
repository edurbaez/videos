const fs = require('fs');
const path = require('path');

const { generarAudio } = require('./audio');
const { obtenerDuracionAudio, ejecutarFFmpeg } = require('./video');
const { parsearDialogo } = require('./guionLargo');

// Google admite 5000 bytes y OpenAI tts-1 4096 chars; 4000 bytes cumple ambos (bytes >= chars)
const MAX_BYTES_CHUNK = 4000;
const CONCURRENCIA_TTS = 4;
const PAUSA_TURNO = 0.35;
const PAUSA_CHUNK = 0.2;
const PAUSA_SECCION = 0.9;

function dividirOraciones(texto) {
  return texto.match(/[^.!?…]+[.!?…]*["»”]?\s*/g) || [texto];
}

/** Divide un texto en trozos <= MAX_BYTES_CHUNK respetando límites de oración. */
function trocearTexto(texto) {
  const oraciones = dividirOraciones(texto);
  const trozos = [];
  let actual = '';
  for (const oracion of oraciones) {
    if (Buffer.byteLength(actual + oracion, 'utf8') > MAX_BYTES_CHUNK && actual) {
      trozos.push(actual.trim());
      actual = '';
    }
    // Oración gigante sin puntuación: cortar por palabras
    if (Buffer.byteLength(oracion, 'utf8') > MAX_BYTES_CHUNK) {
      for (const palabra of oracion.split(/\s+/)) {
        if (Buffer.byteLength(actual + ' ' + palabra, 'utf8') > MAX_BYTES_CHUNK) {
          trozos.push(actual.trim());
          actual = '';
        }
        actual += ' ' + palabra;
      }
    } else {
      actual += oracion;
    }
  }
  if (actual.trim()) trozos.push(actual.trim());
  return trozos;
}

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

/** Une varios MP3 en uno, normalizando a 24 kHz mono y añadiendo una pausa tras cada pieza. */
async function unirPiezas(piezas, rutaDestino) {
  const args = [];
  piezas.forEach(p => args.push('-i', p.ruta));
  const filtros = piezas.map((p, i) =>
    `[${i}:a]aresample=24000,aformat=sample_fmts=fltp:channel_layouts=mono,apad=pad_dur=${p.pausa}[a${i}]`
  );
  const entradas = piezas.map((_, i) => `[a${i}]`).join('');
  filtros.push(`${entradas}concat=n=${piezas.length}:v=0:a=1[out]`);
  args.push(
    '-filter_complex', filtros.join(';'),
    '-map', '[out]',
    '-c:a', 'libmp3lame', '-b:a', '128k', '-ar', '24000', '-ac', '1',
    '-y', rutaDestino,
  );
  await ejecutarFFmpeg(args);
}

/**
 * Sintetiza el guion por secciones y lo une en un único MP3.
 *
 * @param {object[]} secciones  - [{ titulo, texto }]
 * @param {object}   opciones   - { formato: 'monologo'|'dialogo', genero, tts, idioma, dirTrabajo }
 * @param {function} [onProgreso] - (hechos, total) => void
 * @returns {{ duracionTotal: number, capitulos: [{ titulo, inicio }], segmentos: [{ seccion, voz, texto, inicio, fin }] }}
 */
async function generarAudioLargo(secciones, rutaDestino, opciones, onProgreso) {
  const { formato, genero, tts, idioma, dirTrabajo } = opciones;
  fs.mkdirSync(dirTrabajo, { recursive: true });

  const piezasPorSeccion = secciones.map((sec, s) => {
    const turnos = formato === 'dialogo'
      ? parsearDialogo(sec.texto).map(t => ({ voz: t.voz, genero: t.voz === 'F' ? 'femenino' : 'masculino', texto: t.texto }))
      : [{ voz: null, genero, texto: sec.texto.replace(/\s*\n+\s*/g, ' ') }];

    const piezas = [];
    turnos.forEach((turno, t) => {
      const trozos = trocearTexto(turno.texto);
      trozos.forEach((trozo, c) => {
        const ultimoDelTurno = c === trozos.length - 1;
        piezas.push({
          texto: trozo,
          voz: turno.voz,
          genero: turno.genero,
          ruta: path.join(dirTrabajo, `s${s}-t${t}-c${c}.mp3`),
          pausa: ultimoDelTurno && formato === 'dialogo' ? PAUSA_TURNO : PAUSA_CHUNK,
        });
      });
    });
    piezas[piezas.length - 1].pausa = PAUSA_SECCION;
    return piezas;
  });

  const todas = piezasPorSeccion.flat();
  let hechos = 0;
  await ejecutarConLimite(todas.map(p => async () => {
    await generarAudio(p.texto, p.ruta, p.genero, tts, idioma);
    p.duracion = await obtenerDuracionAudio(p.ruta);
    hechos++;
    if (onProgreso) onProgreso(hechos, todas.length);
  }), CONCURRENCIA_TTS);

  const rutasSeccion = [];
  for (let s = 0; s < piezasPorSeccion.length; s++) {
    const rutaSec = path.join(dirTrabajo, `seccion-${s}.mp3`);
    await unirPiezas(piezasPorSeccion[s], rutaSec);
    rutasSeccion.push(rutaSec);
  }

  const capitulos = [];
  const segmentos = [];
  let inicio = 0;
  for (let s = 0; s < rutasSeccion.length; s++) {
    const duracionSeccion = await obtenerDuracionAudio(rutasSeccion[s]);
    capitulos.push({ titulo: secciones[s].titulo, inicio });
    segmentos.push(...segmentarSeccion(piezasPorSeccion[s], s, inicio, duracionSeccion));
    inicio += duracionSeccion;
  }

  // Todas las secciones ya comparten formato: concat demuxer sin recodificar
  const lista = path.join(dirTrabajo, 'lista.txt');
  fs.writeFileSync(lista, rutasSeccion.map(r => `file '${r.replace(/\\/g, '/')}'`).join('\n'), 'utf-8');
  await ejecutarFFmpeg(['-f', 'concat', '-safe', '0', '-i', lista, '-c', 'copy', '-y', rutaDestino]);

  return { duracionTotal: await obtenerDuracionAudio(rutaDestino), capitulos, segmentos };
}

/**
 * Línea de tiempo por oración de una sección. Los tiempos por pieza son exactos; dentro de
 * una pieza se reparten por longitud de oración. Se reescala a la duración real de la sección
 * para absorber el desfase del remuestreo/concat.
 */
function segmentarSeccion(piezas, seccion, inicioSeccion, duracionSeccion) {
  const bruto = piezas.reduce((a, p) => a + p.duracion + p.pausa, 0);
  const escala = bruto > 0 ? duracionSeccion / bruto : 1;
  const segmentos = [];
  let t = inicioSeccion;
  for (const p of piezas) {
    const oraciones = dividirOraciones(p.texto).map(o => o.trim()).filter(Boolean);
    const chars = oraciones.reduce((a, o) => a + o.length, 0) || 1;
    const durHabla = p.duracion * escala;
    for (const o of oraciones) {
      const d = durHabla * o.length / chars;
      segmentos.push({ seccion, voz: p.voz, texto: o, inicio: t, fin: t + d });
      t += d;
    }
    t += p.pausa * escala;
  }
  return segmentos;
}

/** Formatea segundos como capítulo de YouTube (m:ss o h:mm:ss). */
function formatearTiempo(seg) {
  const s = Math.floor(seg);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

module.exports = { generarAudioLargo, formatearTiempo, trocearTexto };
