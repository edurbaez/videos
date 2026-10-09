const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { ts } = require('../utils/log');
const { ejecutarConLimite } = require('../utils/concurrencia');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = FFMPEG.replace('ffmpeg.exe', 'ffprobe.exe').replace(/ffmpeg$/, 'ffprobe');

/**
 * Obtiene la duración en segundos de un archivo de audio usando ffprobe.
 *
 * @param {string} rutaAudio - Ruta al archivo MP3
 * @returns {Promise<number>} - Duración en segundos
 */
function obtenerDuracionAudio(rutaAudio) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      rutaAudio,
    ];
    const proc = spawn(FFPROBE, args);
    let salida = '';
    proc.stdout.on('data', d => { salida += d.toString(); });
    proc.stderr.on('data', () => {});
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`ffprobe salió con código ${code}`));
      try {
        const data = JSON.parse(salida);
        const duracion = parseFloat(data.streams[0].duration);
        resolve(duracion);
      } catch (e) {
        reject(new Error('No se pudo parsear la duración del audio: ' + e.message));
      }
    });
    proc.on('error', reject);
  });
}

/**
 * Ejecuta un comando FFmpeg y retorna una promesa.
 * Loguea el progreso de FFmpeg en consola.
 *
 * @param {string[]} args - Array de argumentos para FFmpeg
 * @returns {Promise<void>}
 */
function ejecutarFFmpeg(args) {
  return new Promise((resolve, reject) => {
    console.log(`[${ts()}] FFmpeg: iniciando comando...`);
    const proc = spawn(FFMPEG, args);
    let stderrLog = '';

    proc.stdout.on('data', d => process.stdout.write(d));
    proc.stderr.on('data', d => {
      const texto = d.toString();
      stderrLog += texto;
      // Mostrar líneas de progreso de FFmpeg
      if (texto.includes('time=') || texto.includes('frame=')) {
        process.stdout.write(`\r[FFmpeg] ${texto.trim()}`);
      }
    });

    proc.on('close', code => {
      if (code === 0) {
        console.log(`\n[${ts()}] FFmpeg: proceso completado con éxito.`);
        resolve();
      } else {
        reject(new Error(`FFmpeg falló con código ${code}.\nSTDERR:\n${stderrLog}`));
      }
    });
    proc.on('error', err => {
      reject(new Error(`No se pudo iniciar FFmpeg: ${err.message}\nRuta configurada: ${FFMPEG}`));
    });
  });
}

/**
 * Convierte una ruta Windows a forward slashes para pasarla al filtro
 * subtitles de FFmpeg. El path se pasa entre comillas simples dentro del
 * filtergraph, lo que protege el ':' del drive sin necesidad de escaparlo.
 * @param {string} ruta
 * @returns {string}
 */
function escaparRutaSRT(ruta) {
  return ruta.replace(/\\/g, '/');
}

/**
 * Arma el video final vertical (1080x1920) para YouTube Shorts.
 *
 * Flujo:
 *  1. Obtiene la duración del audio
 *  2. Calcula cuánto tiempo mostrar cada imagen
 *  3. Construye un filtergraph que:
 *     - Escala cada imagen a 1080x1920 con padding negro (letterbox/pillarbox)
 *     - Aplica transiciones xfade:fade entre cada par de imágenes
 *     - (Opcional) Quema subtítulos .srt sobre el video con libass
 *  4. Mezcla el video resultante con el audio
 *  5. Exporta como H.264 + AAC, listo para subir a YouTube Shorts
 *
 * @param {string}   rutaAudio     - Ruta al MP3 del audio
 * @param {string[]} rutasImagenes - Array de rutas absolutas de las imágenes
 * @param {string}   rutaDestino   - Ruta donde guardar el MP4 final
 * @param {string}   [rutaSRT]     - Ruta al archivo .srt (opcional); si se provee, los subtítulos se queman en el video
 * @returns {string} - Ruta del video generado
 */
async function generarVideo(rutaAudio, rutasImagenes, rutaDestino, rutaSRT = null) {
  const n = rutasImagenes.length;
  const FADE_DURATION = 0.5;

  console.log(`[${ts()}] Video: obteniendo duración del audio...`);
  const duracionTotal = await obtenerDuracionAudio(rutaAudio);
  console.log(`[${ts()}] Video: duración del audio = ${duracionTotal.toFixed(2)}s`);

  // Tiempo base por imagen (suficiente para los fades)
  const tiempoPorImagen = Math.max(duracionTotal / n, FADE_DURATION * 2 + 1);

  // Calcular cuántos slots se necesitan para que el video cubra todo el audio.
  // Duración total con k slots = k * tiempoPorImagen - (k-1) * FADE_DURATION
  // Despejando k: k >= (duracionTotal - FADE_DURATION) / (tiempoPorImagen - FADE_DURATION)
  const slots = Math.max(n, Math.ceil((duracionTotal - FADE_DURATION) / (tiempoPorImagen - FADE_DURATION)));
  console.log(`[${ts()}] Video: tiempo/imagen = ${tiempoPorImagen.toFixed(2)}s, slots = ${slots} (${Math.ceil(slots / n)} ciclo(s) de ${n} imagen(es))`);

  // Construir array en bucle: las imágenes se repiten cíclicamente
  const imagenesLoop = Array.from({ length: slots }, (_, i) => rutasImagenes[i % n]);

  // ── Construir argumentos FFmpeg ────────────────────────────────────────────
  const args = [];

  for (const ruta of imagenesLoop) {
    args.push('-loop', '1', '-t', tiempoPorImagen.toFixed(3), '-i', ruta);
  }
  args.push('-i', rutaAudio);

  // ── Filtergraph ────────────────────────────────────────────────────────────
  const filterParts = [];
  for (let i = 0; i < slots; i++) {
    filterParts.push(
      `[${i}:v]scale=1080:1920:force_original_aspect_ratio=decrease,` +
      `pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1[v${i}]`
    );
  }

  let lastLabel = 'v0';
  let offset = tiempoPorImagen - FADE_DURATION;

  for (let i = 1; i < slots; i++) {
    const outLabel = i === slots - 1 ? 'vout' : `xf${i}`;
    filterParts.push(
      `[${lastLabel}][v${i}]xfade=transition=fade:duration=${FADE_DURATION}:offset=${offset.toFixed(3)}[${outLabel}]`
    );
    lastLabel = outLabel;
    offset += tiempoPorImagen - FADE_DURATION;
  }

  if (slots === 1) {
    filterParts.push(`[v0]null[vout]`);
  }

  // Quemar subtítulos si se proporcionó un archivo SRT
  const mapaVideo = rutaSRT ? '[vfinal]' : '[vout]';
  if (rutaSRT) {
    const srtEscapado = escaparRutaSRT(rutaSRT);
    filterParts.push(
      `[vout]subtitles=filename='${srtEscapado}':force_style='FontName=Arial,FontSize=22,Bold=1,` +
      `PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Shadow=1,` +
      `Alignment=2,MarginV=80'[vfinal]`
    );
  }

  const filtergraph = filterParts.join(';');
  const audioInput = slots;

  args.push(
    '-filter_complex', filtergraph,
    '-map', mapaVideo,
    '-map', `${audioInput}:a`,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-pix_fmt', 'yuv420p',
    '-shortest',
    '-movflags', '+faststart',
    '-y',
    rutaDestino,
  );

  console.log(`[${ts()}] Video: iniciando renderizado...`);
  await ejecutarFFmpeg(args);
  console.log(`[${ts()}] Video: video guardado en ${rutaDestino}`);

  return rutaDestino;
}

// ── Video por escenas (largo / curso) ─────────────────────────────────────────

const FPS_ESCENAS = 25;
const TRANSICION_ESCENAS = 0.6;
const SEGUNDOS_SEGMENTO = 120;
// zoompan recorta en píxeles enteros de su entrada: con la imagen al doble el temblor queda en medio píxel
const ESCALA_KEN_BURNS = 2;
const ZOOM_KEN_BURNS = 0.12;
const CONCURRENCIA_SEGMENTOS = Math.max(1, Math.min(3, Math.floor(os.cpus().length / 2)));
const DIR_MUSICA = path.join(__dirname, '..', 'assets', 'musica');
const EXT_MUSICA = /\.(mp3|wav|m4a|aac|ogg|oga|flac|opus)$/i;
const VOLUMEN_MUSICA = 0.18;
const LOUDNORM = 'I=-14:TP=-2:LRA=11';

// x/y: posición del recorte dentro del margen libre (0 = izquierda/arriba, 1 = derecha/abajo).
// Seis movimientos en ciclo: dos escenas seguidas nunca repiten movimiento.
const MOVIMIENTOS_KEN_BURNS = [
  { z: [1, 1 + ZOOM_KEN_BURNS], x: [0.5, 0.5], y: [0.5, 0.5] },
  { z: [1 + ZOOM_KEN_BURNS * 0.8, 1 + ZOOM_KEN_BURNS * 0.8], x: [0, 1], y: [0.4, 0.4] },
  { z: [1 + ZOOM_KEN_BURNS, 1], x: [0.5, 0.5], y: [0.3, 0.5] },
  { z: [1 + ZOOM_KEN_BURNS * 0.8, 1 + ZOOM_KEN_BURNS * 0.8], x: [1, 0], y: [0.5, 0.5] },
  { z: [1, 1 + ZOOM_KEN_BURNS], x: [0.5, 0.3], y: [0.5, 0.3] },
  { z: [1 + ZOOM_KEN_BURNS, 1], x: [0.7, 0.5], y: [0.3, 0.5] },
];

const movimientoKenBurns = i => {
  const n = MOVIMIENTOS_KEN_BURNS.length;
  return MOVIMIENTOS_KEN_BURNS[((i % n) + n) % n];
};

const num = v => String(+v.toFixed(6));

/** Expresiones de zoompan para una toma de `largo` frames de la que se renderiza desde el frame `offset`. */
function expresionesKenBurns(mov, offset, largo) {
  const p = `((on+${offset})/${Math.max(1, largo - 1)})`;
  const lineal = ([a, b]) => (a === b ? num(a) : `(${num(a)}+${num(b - a)}*${p})`);
  return {
    z: lineal(mov.z),
    x: `(iw-iw/zoom)*${lineal(mov.x)}`,
    y: `(ih-ih/zoom)*${lineal(mov.y)}`,
  };
}

/**
 * Pasa las escenas a frames y las reparte en segmentos que se renderizan por separado.
 * Cada toma se alarga media transición a cada lado para que el crossfade quede centrado en el
 * límite de la escena y el total siga siendo la duración del audio. Los segmentos se cortan a
 * mitad de una escena (fuera de cualquier transición), así unirlos con concat no deja costura.
 */
function planificarEscenas(escenas, duracion, { fps = FPS_ESCENAS, transicion = TRANSICION_ESCENAS, segundosSegmento = SEGUNDOS_SEGMENTO } = {}) {
  const total = Math.max(1, Math.round(duracion * fps));
  const cortes = [0];
  for (let i = 1; i < escenas.length; i++) {
    cortes.push(Math.min(total, Math.max(cortes[i - 1], Math.round(escenas[i].inicio * fps))));
  }
  cortes.push(total);

  const tomas = [];
  escenas.forEach((e, i) => {
    if (cortes[i + 1] > cortes[i]) tomas.push({ imagen: e.imagen, mov: i, ini: cortes[i], fin: cortes[i + 1] });
  });
  const medio = Math.round((transicion * fps) / 2);
  const mitades = tomas.slice(0, -1).map((t, i) =>
    Math.min(medio, Math.floor(Math.min(t.fin - t.ini, tomas[i + 1].fin - tomas[i + 1].ini) / 4)));
  tomas.forEach((t, i) => {
    t.desde = t.ini - (i > 0 ? mitades[i - 1] : 0);
    t.hasta = t.fin + (i < mitades.length ? mitades[i] : 0);
  });

  const limites = [0];
  const objetivo = segundosSegmento * fps;
  for (const t of tomas) {
    const c = Math.floor((t.ini + t.fin) / 2);
    if (c - limites[limites.length - 1] >= objetivo && total - c >= objetivo * 0.3) limites.push(c);
  }
  limites.push(total);

  const segmentos = limites.slice(0, -1).map((inicio, k) => {
    const fin = limites[k + 1];
    return {
      inicio, fin,
      tomas: tomas.filter(t => t.desde < fin && t.hasta > inicio).map(t => ({
        imagen: t.imagen, mov: t.mov, largo: t.hasta - t.desde,
        desde: Math.max(t.desde, inicio), hasta: Math.min(t.hasta, fin), offset: Math.max(t.desde, inicio) - t.desde,
      })),
    };
  });
  return { fps, total, segmentos };
}

/** Filtergraph de un segmento: Ken Burns por toma, crossfades y texto ASS desplazado al tiempo global. */
function filtroSegmento(seg, { fps, ancho, alto, rutaAss = null }) {
  const w = ancho * ESCALA_KEN_BURNS;
  const h = alto * ESCALA_KEN_BURNS;
  const partes = seg.tomas.map((t, k) => {
    const { z, x, y } = expresionesKenBurns(movimientoKenBurns(t.mov), t.offset, t.largo);
    return `[${k}:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,` +
      `zoompan=z='${z}':x='${x}':y='${y}':d=${t.hasta - t.desde}:s=${ancho}x${alto}:fps=${fps},format=yuv420p,setsar=1[t${k}]`;
  });
  let actual = 't0';
  for (let k = 1; k < seg.tomas.length; k++) {
    const solape = seg.tomas[k - 1].hasta - seg.tomas[k].desde;
    const salida = `x${k}`;
    partes.push(solape > 0
      ? `[${actual}][t${k}]xfade=transition=fade:duration=${num(solape / fps)}:offset=${num((seg.tomas[k].desde - seg.inicio) / fps)}[${salida}]`
      : `[${actual}][t${k}]concat=n=2:v=1:a=0[${salida}]`);
    actual = salida;
  }
  // Las comillas se consumen antes del parseo de opciones: el ':' de la unidad (C:) va escapado
  partes.push(rutaAss
    ? `[${actual}]setpts=PTS+${num(seg.inicio / fps)}/TB,subtitles=filename='${escaparRutaSRT(rutaAss).replace(/:/g, '\\:')}',setpts=PTS-STARTPTS[vout]`
    : `[${actual}]null[vout]`);
  return { entradas: seg.tomas.map(t => t.imagen), filtro: partes.join(';') };
}

/**
 * Mezcla la voz con música opcional (en bucle, atenuada y con ducking bajo la voz) y normaliza.
 * `loudnorm` es el filtro final ya armado (medición o pasada lineal).
 */
function filtroAudio({ duracion, conMusica, loudnorm }) {
  const partes = [];
  const voz = '[0:a]aformat=sample_rates=48000:channel_layouts=stereo';
  if (conMusica) {
    const fade = Math.min(3, duracion / 4);
    partes.push(
      `${voz},asplit=2[voz][guia]`,
      `[1:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:${num(duracion)},asetpts=PTS-STARTPTS,volume=${VOLUMEN_MUSICA},` +
        `afade=t=in:d=${num(fade)},afade=t=out:st=${num(Math.max(0, duracion - fade))}:d=${num(fade)}[mus]`,
      '[mus][guia]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=400[fondo]',
      '[voz][fondo]amix=inputs=2:duration=first:normalize=0[mezcla]',
    );
  } else {
    partes.push(`${voz}[mezcla]`);
  }
  partes.push(`[mezcla]${loudnorm},aresample=48000[aout]`);
  return partes.join(';');
}

/** Filtro de la 2.ª pasada de loudnorm a partir del JSON de la 1.ª; modo dinámico si no hay medición útil. */
function loudnormLineal(stderr) {
  const m = String(stderr).match(/\{[^{}]*"input_i"[^{}]*\}/);
  if (!m) return `loudnorm=${LOUDNORM}`;
  try {
    const d = JSON.parse(m[0]);
    const vals = [d.input_i, d.input_tp, d.input_lra, d.input_thresh, d.target_offset].map(Number);
    if (vals.some(v => !Number.isFinite(v))) return `loudnorm=${LOUDNORM}`;
    const [i, tp, lra, thresh, offset] = vals;
    return `loudnorm=${LOUDNORM}:measured_I=${i}:measured_TP=${tp}:measured_LRA=${lra}:measured_thresh=${thresh}:offset=${offset}:linear=true`;
  } catch {
    return `loudnorm=${LOUDNORM}`;
  }
}

/** Pista de fondo determinista por `semilla` desde assets/musica; null si está desactivada o no hay pistas. */
function elegirMusica(semilla, dir = DIR_MUSICA) {
  if (String(process.env.LARGO_MUSICA || '').toLowerCase() === 'false') return null;
  let pistas;
  try {
    pistas = fs.readdirSync(dir).filter(f => EXT_MUSICA.test(f) && !f.startsWith('.')).sort();
  } catch {
    return null;
  }
  if (!pistas.length) return null;
  let hash = 0;
  for (const c of String(semilla)) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return path.join(dir, pistas[hash % pistas.length]);
}

/** Como ejecutarFFmpeg pero sin volcar progreso (corren varios a la vez); devuelve el stderr. */
function ejecutarFFmpegSilencioso(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, ['-hide_banner', '-nostats', ...args]);
    let stderrLog = '';
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', d => { stderrLog += d.toString(); });
    proc.on('close', code => {
      if (code === 0) resolve(stderrLog);
      else reject(new Error(`FFmpeg falló con código ${code}.\nSTDERR:\n${stderrLog.slice(-4000)}`));
    });
    proc.on('error', err => reject(new Error(`No se pudo iniciar FFmpeg: ${err.message}\nRuta configurada: ${FFMPEG}`)));
  });
}

/** Voz + música opcional con ducking, loudnorm en 2 pasadas (-14 LUFS) → AAC 192k 48 kHz. */
async function renderizarAudioEscenas(rutaAudio, rutaSalida, duracion, musica) {
  const entradas = ['-i', rutaAudio, ...(musica ? ['-stream_loop', '-1', '-i', musica] : [])];
  const conMusica = !!musica;
  const medicion = await ejecutarFFmpegSilencioso([
    ...entradas,
    '-filter_complex', filtroAudio({ duracion, conMusica, loudnorm: `loudnorm=${LOUDNORM}:print_format=json` }),
    '-map', '[aout]', '-t', num(duracion), '-f', 'null', '-',
  ]);
  await ejecutarFFmpegSilencioso([
    '-loglevel', 'error',
    ...entradas,
    '-filter_complex', filtroAudio({ duracion, conMusica, loudnorm: loudnormLineal(medicion) }),
    '-map', '[aout]', '-t', num(duracion), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-y', rutaSalida,
  ]);
}

/** Mux final sin recodificar: entrada de video + audio terminado, cortado a la duración del audio, faststart. */
function unirVideoAudio(entradaVideo, rutaAudioFinal, duracion, rutaDestino) {
  return ejecutarFFmpeg([
    ...entradaVideo,
    '-i', rutaAudioFinal,
    '-map', '0:v', '-map', '1:a',
    '-c', 'copy',
    '-t', num(duracion),
    '-movflags', '+faststart',
    '-y', rutaDestino,
  ]);
}

/**
 * Video con una imagen por escena: Ken Burns, crossfades centrados en los límites de escena,
 * texto ASS quemado opcional, música de fondo con ducking y loudnorm final (-14 LUFS).
 * Se renderiza en segmentos de ~2 min en paralelo (un único filtergraph con 100 entradas es lento
 * y supera el límite de línea de comandos de Windows) que se unen con concat sin recodificar.
 *
 * @param {object[]} escenas - [{ imagen, inicio, fin }] contiguas y ordenadas
 * @param {string|false} [opciones.musica] - ruta de la pista o false para omitirla; por defecto se elige de assets/musica
 */
async function generarVideoEscenas(rutaAudio, escenas, rutaDestino, { rutaAss = null, dirTrabajo, ancho = 1920, alto = 1080, musica } = {}) {
  const t0 = Date.now();
  const duracion = await obtenerDuracionAudio(rutaAudio);
  const plan = planificarEscenas(escenas, duracion);
  const pista = musica === undefined ? elegirMusica(path.basename(rutaDestino)) : (musica || null);
  console.log(`[${ts()}] Video escenas: ${escenas.length} imágenes, ${duracion.toFixed(1)}s, ${plan.segmentos.length} segmento(s)${pista ? `, música ${path.basename(pista)}` : ''}`);

  const dir = path.join(dirTrabajo, `render-${path.basename(rutaDestino, path.extname(rutaDestino))}`);
  fs.mkdirSync(dir, { recursive: true });
  const rutasSegmentos = plan.segmentos.map((_, k) => path.join(dir, `seg-${String(k).padStart(3, '0')}.mp4`));
  const rutaAudioFinal = path.join(dir, 'audio.m4a');

  try {
    let hechos = 0;
    const video = ejecutarConLimite(plan.segmentos.map((seg, k) => async () => {
      const { entradas, filtro } = filtroSegmento(seg, { fps: plan.fps, ancho, alto, rutaAss });
      await ejecutarFFmpegSilencioso([
        '-loglevel', 'error',
        ...entradas.flatMap(r => ['-i', r]),
        '-filter_complex', filtro,
        '-map', '[vout]', '-frames:v', String(seg.fin - seg.inicio),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-r', String(plan.fps),
        '-an', '-y', rutasSegmentos[k],
      ]);
      console.log(`[${ts()}] Video escenas: segmento ${++hechos}/${plan.segmentos.length} listo`);
    }), CONCURRENCIA_SEGMENTOS);
    await Promise.all([video, renderizarAudioEscenas(rutaAudio, rutaAudioFinal, duracion, pista)]);

    const rutaLista = path.join(dir, 'segmentos.txt');
    fs.writeFileSync(rutaLista, rutasSegmentos.map(r => `file '${r.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf-8');
    await unirVideoAudio(['-f', 'concat', '-safe', '0', '-i', rutaLista], rutaAudioFinal, duracion, rutaDestino);
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
  const seg = (Date.now() - t0) / 1000;
  console.log(`[${ts()}] Video escenas: listo en ${seg.toFixed(0)}s (${(seg / duracion).toFixed(2)}x la duración)`);
  return rutaDestino;
}

module.exports = {
  generarVideo, generarVideoEscenas, obtenerDuracionAudio, ejecutarFFmpeg,
  planificarEscenas, filtroSegmento, filtroAudio, loudnormLineal, elegirMusica, movimientoKenBurns, expresionesKenBurns,
  renderizarAudioEscenas, unirVideoAudio,
};
