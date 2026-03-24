const path = require('path');
const { spawn } = require('child_process');
require('dotenv').config();

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
  const ts = () => new Date().toTimeString().slice(0, 8);
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
  const ts = () => new Date().toTimeString().slice(0, 8);
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

module.exports = { generarVideo };
