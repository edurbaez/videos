const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { generarAudio } = require('./audio');
const { obtenerDuracionAudio, ejecutarFFmpeg } = require('./video');
const { parsearDialogo } = require('./guionLargo');
const { alinearAudio, estimarPalabras } = require('./alineacion');
const { ejecutarConLimite } = require('../utils/concurrencia');
const { ts } = require('../utils/log');

// Google admite 5000 bytes y OpenAI tts-1 4096 chars; 4000 bytes cumple ambos (bytes >= chars)
const MAX_BYTES_CHUNK = 4000;
// Chirp 3 HD / gpt-4o-mini-tts keep prosody stable on ~1-2 min pieces (Google's long-form advice)
const MAX_BYTES_CHUNK_HD = 2500;
const CONCURRENCIA_TTS = 4;
const CONCURRENCIA_ALINEACION = 3;
const PAUSA_TURNO = 0.35;
const PAUSA_CHUNK = 0.2;
const PAUSA_SECCION = 0.9;
const SAMPLE_RATE_INTERMEDIO = 24000;
const LOUDNORM = 'I=-16:TP=-1.5:LRA=11';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

function dividirOraciones(texto) {
  // Closing quotes stay with their sentence (German „…“ closes with “)
  return texto.match(/[^.!?…]+[.!?…]*["»”“’]?\s*/g) || [texto];
}

/** Divide un texto en trozos <= maxBytes respetando límites de oración. */
function trocearTexto(texto, maxBytes = MAX_BYTES_CHUNK) {
  const oraciones = dividirOraciones(texto);
  const trozos = [];
  let actual = '';
  for (const oracion of oraciones) {
    if (Buffer.byteLength(actual + oracion, 'utf8') > maxBytes && actual) {
      trozos.push(actual.trim());
      actual = '';
    }
    // Oración gigante sin puntuación: cortar por palabras
    if (Buffer.byteLength(oracion, 'utf8') > maxBytes) {
      for (const palabra of oracion.split(/\s+/)) {
        if (Buffer.byteLength(actual + ' ' + palabra, 'utf8') > maxBytes) {
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

/** Une varios MP3 en un WAV PCM (duración exacta, sin padding de MP3) con una pausa tras cada pieza. */
async function unirPiezas(piezas, rutaDestino) {
  const args = [];
  piezas.forEach(p => args.push('-i', p.ruta));
  const filtros = piezas.map((p, i) =>
    `[${i}:a]aresample=${SAMPLE_RATE_INTERMEDIO},aformat=sample_fmts=fltp:channel_layouts=mono,apad=pad_dur=${p.pausa}[a${i}]`
  );
  const entradas = piezas.map((_, i) => `[a${i}]`).join('');
  filtros.push(`${entradas}concat=n=${piezas.length}:v=0:a=1[out]`);
  args.push(
    '-filter_complex', filtros.join(';'),
    '-map', '[out]',
    '-c:a', 'pcm_s16le', '-ar', String(SAMPLE_RATE_INTERMEDIO), '-ac', '1',
    '-y', rutaDestino,
  );
  await ejecutarFFmpeg(args);
}

/** Ejecuta FFmpeg y devuelve su stderr (ejecutarFFmpeg no lo expone; loudnorm imprime ahí su medición). */
function ffmpegConSalida(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args);
    let err = '';
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('close', code => (code === 0 ? resolve(err) : reject(new Error(`FFmpeg salió con código ${code}: ${err.slice(-500)}`))));
    proc.on('error', reject);
  });
}

/** Normaliza la voz (loudnorm en dos pasadas, lineal si se puede) y la codifica a MP3 48 kHz 192k. */
async function normalizarVoz(entrada, rutaDestino) {
  const entradaArgs = ['-f', 'concat', '-safe', '0', '-i', entrada];
  let filtro = `loudnorm=${LOUDNORM}`;
  try {
    const salida = await ffmpegConSalida(['-hide_banner', '-nostats', ...entradaArgs, '-af', `${filtro}:print_format=json`, '-f', 'null', '-']);
    const m = JSON.parse(salida.slice(salida.lastIndexOf('{'), salida.lastIndexOf('}') + 1));
    const valores = [m.input_i, m.input_tp, m.input_lra, m.input_thresh, m.target_offset].map(Number);
    if (valores.every(Number.isFinite)) {
      filtro += `:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}`
        + `:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
    }
  } catch (err) {
    console.warn(`[${ts()}] AudioLargo: medición loudnorm falló, se normaliza en una pasada: ${err.message.slice(0, 200)}`);
  }
  await ejecutarFFmpeg([...entradaArgs, '-af', filtro, '-c:a', 'libmp3lame', '-b:a', '192k', '-ar', '48000', '-ac', '1', '-y', rutaDestino]);
}

function hdActivo() {
  return process.env.LARGO_TTS_HD !== 'false';
}

function alineacionActiva() {
  return process.env.LARGO_ALINEAR !== 'false' && !!process.env.OPENAI_API_KEY;
}

/** Tiempos reales de una sección con Whisper; null si falla (se mantiene la estimación). */
async function alinearSeccion(rutaWav, estimados, idioma, duracionSeccion) {
  const rutaFlac = rutaWav.replace(/\.wav$/, '-whisper.flac');
  // 16 kHz mono FLAC: lossless (no MP3 encoder delay shifting timestamps) and ~4x smaller than the WAV
  await ejecutarFFmpeg(['-i', rutaWav, '-ar', '16000', '-ac', '1', '-c:a', 'flac', '-y', rutaFlac]);
  const r = await alinearAudio(rutaFlac, estimados.map(s => s.texto), idioma, duracionSeccion);
  if (!r) return null;
  return estimados.map((s, k) => ({ ...s, inicio: r.oraciones[k].inicio, fin: r.oraciones[k].fin, palabras: r.oraciones[k].palabras }));
}

/**
 * Sintetiza el guion por secciones y lo une en un único MP3 normalizado.
 * Perfil HD (Chirp 3 HD / gpt-4o-mini-tts) salvo LARGO_TTS_HD=false; tiempos alineados con Whisper salvo LARGO_ALINEAR=false.
 *
 * @param {object[]} secciones  - [{ titulo, texto }]
 * @param {object}   opciones   - { formato: 'monologo'|'dialogo', genero, tts, idioma, dirTrabajo }
 * @param {function} [onProgreso] - (hechos, total) => void
 * @returns {{ duracionTotal: number, capitulos: [{ titulo, inicio }], segmentos: [{ seccion, voz, texto, inicio, fin, palabras }] }}
 */
async function generarAudioLargo(secciones, rutaDestino, opciones, onProgreso) {
  const { formato, genero, tts, idioma, dirTrabajo } = opciones;
  fs.mkdirSync(dirTrabajo, { recursive: true });
  const hd = hdActivo();
  const maxBytes = hd ? MAX_BYTES_CHUNK_HD : MAX_BYTES_CHUNK;

  const piezasPorSeccion = secciones.map((sec, s) => {
    const turnos = formato === 'dialogo'
      ? parsearDialogo(sec.texto).map(t => ({ voz: t.voz, genero: t.voz === 'F' ? 'femenino' : 'masculino', texto: t.texto }))
      : [{ voz: null, genero, texto: sec.texto.replace(/\s*\n+\s*/g, ' ') }];

    const piezas = [];
    turnos.forEach((turno, t) => {
      const trozos = trocearTexto(turno.texto, maxBytes);
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
    const opcionesTts = hd ? { perfil: 'hd', rol: p.voz === 'M' ? 'alumno' : 'profesor' } : {};
    await generarAudio(p.texto, p.ruta, p.genero, tts, idioma, undefined, opcionesTts);
    p.duracion = await obtenerDuracionAudio(p.ruta);
    hechos++;
    if (onProgreso) onProgreso(hechos, todas.length);
  }), CONCURRENCIA_TTS);

  const rutasSeccion = [];
  for (let s = 0; s < piezasPorSeccion.length; s++) {
    const rutaSec = path.join(dirTrabajo, `seccion-${s}.wav`);
    await unirPiezas(piezasPorSeccion[s], rutaSec);
    rutasSeccion.push(rutaSec);
  }

  const duraciones = [];
  for (const r of rutasSeccion) duraciones.push(await obtenerDuracionAudio(r));
  const estimadosPorSeccion = piezasPorSeccion.map((piezas, s) => segmentarSeccion(piezas, s, 0, duraciones[s]));

  const relativosPorSeccion = estimadosPorSeccion.slice();
  if (alineacionActiva()) {
    let alineadas = 0;
    await ejecutarConLimite(rutasSeccion.map((ruta, s) => async () => {
      const alineado = await alinearSeccion(ruta, estimadosPorSeccion[s], idioma, duraciones[s]).catch(err => {
        console.warn(`[${ts()}] AudioLargo: alineación de la sección ${s} falló: ${err.message.slice(0, 200)}`);
        return null;
      });
      if (alineado) { relativosPorSeccion[s] = alineado; alineadas++; }
    }), CONCURRENCIA_ALINEACION);
    console.log(`[${ts()}] AudioLargo: ${alineadas}/${rutasSeccion.length} secciones alineadas con Whisper.`);
  }

  const capitulos = [];
  const segmentos = [];
  let inicio = 0;
  for (let s = 0; s < rutasSeccion.length; s++) {
    capitulos.push({ titulo: secciones[s].titulo, inicio });
    segmentos.push(...relativosPorSeccion[s].map(seg => desplazarSegmento(seg, inicio)));
    inicio += duraciones[s];
  }

  // WAV sections concatenate sample-exact, so section offsets match the final file
  const lista = path.join(dirTrabajo, 'lista.txt');
  fs.writeFileSync(lista, rutasSeccion.map(r => `file '${r.replace(/\\/g, '/')}'`).join('\n'), 'utf-8');
  await normalizarVoz(lista, rutaDestino);

  const duracionTotal = await obtenerDuracionAudio(rutaDestino);
  if (Math.abs(duracionTotal - inicio) > 0.25) {
    console.warn(`[${ts()}] AudioLargo: el MP3 final dura ${duracionTotal.toFixed(2)}s y las secciones suman ${inicio.toFixed(2)}s.`);
  }
  return { duracionTotal, capitulos, segmentos };
}

function desplazarSegmento(seg, offset) {
  return {
    ...seg,
    inicio: seg.inicio + offset,
    fin: seg.fin + offset,
    palabras: seg.palabras.map(p => ({ texto: p.texto, inicio: p.inicio + offset, fin: p.fin + offset })),
  };
}

/**
 * Línea de tiempo estimada por oración de una sección (respaldo si no hay alineación). Los tiempos
 * por pieza son exactos; dentro de una pieza se reparten por longitud de oración. Se reescala a la
 * duración real de la sección para absorber el desfase del remuestreo/concat.
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
      segmentos.push({ seccion, voz: p.voz, texto: o, inicio: t, fin: t + d, palabras: estimarPalabras(o, t, t + d) });
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

module.exports = { generarAudioLargo, formatearTiempo, trocearTexto, segmentarSeccion };
