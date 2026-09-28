const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Rutas base para cada tipo de output
const BASE = path.join(__dirname, '..', 'output');
const DIR_GUIONES    = path.join(BASE, 'guiones');
const DIR_AUDIOS     = path.join(BASE, 'audios');
const DIR_IMAGENES   = path.join(BASE, 'imagenes');
const DIR_VIDEOS     = path.join(BASE, 'videos');
const DIR_SUBTITULOS  = path.join(BASE, 'subtitulos');
const DIR_REFERENCIAS = path.join(BASE, 'referencias');
const DIR_CURSO       = path.join(BASE, 'curso');
const DIR_LARGO       = path.join(BASE, 'largo');

/**
 * Crea todas las carpetas de output si no existen.
 * Se llama al iniciar el servidor.
 */
function crearCarpetas() {
  [DIR_GUIONES, DIR_AUDIOS, DIR_IMAGENES, DIR_VIDEOS, DIR_SUBTITULOS, DIR_REFERENCIAS, DIR_CURSO, DIR_LARGO].forEach(dir => {
    fs.mkdirSync(dir, { recursive: true });
  });
  console.log('[archivos] Carpetas de output verificadas.');
}

/** Retorna la ruta absoluta del guion de texto para un ID dado */
function rutaGuion(id) {
  return path.join(DIR_GUIONES, `guion-${id}.txt`);
}

/** Retorna la ruta absoluta del audio MP3 para un ID dado */
function rutaAudio(id) {
  return path.join(DIR_AUDIOS, `audio-${id}.mp3`);
}

/** Retorna la ruta absoluta de la imagen N para un ID dado */
function rutaImagen(id, n) {
  return path.join(DIR_IMAGENES, `imagen-${id}-${n}.png`);
}

/** Retorna la ruta absoluta del video final para un ID dado */
function rutaVideo(id) {
  return path.join(DIR_VIDEOS, `video-${id}.mp4`);
}

/** Retorna la ruta absoluta del archivo SRT de subtítulos para un ID dado */
function rutaSubtitulo(id) {
  return path.join(DIR_SUBTITULOS, `subtitulo-${id}.srt`);
}

/** Public URL (served under /output) for an absolute path inside output/ */
function urlDeRuta(ruta) {
  const relativa = path.relative(BASE, ruta);
  if (relativa.startsWith('..') || path.isAbsolute(relativa)) throw new Error(`Ruta fuera de output/: ${ruta}`);
  return `/output/${relativa.split(path.sep).join('/')}`;
}

const urlAudio     = id => `/output/audios/audio-${id}.mp3`;
const urlImagen    = (id, n) => `/output/imagenes/imagen-${id}-${n}.png`;
const urlVideo     = id => `/output/videos/video-${id}.mp4`;
const urlCurso     = nombre => `/output/curso/${nombre}`;

const INTENTOS_RENAME = 5;
const esperaSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Writes via temp file + rename so a crash never leaves a half-written file.
 * On Windows rename can fail with EBUSY/EPERM while another process (antivirus, editor)
 * holds the target open, so it retries briefly before giving up.
 */
function escribirAtomico(ruta, contenido) {
  const tmp = `${ruta}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, contenido, 'utf-8');
  for (let intento = 1; ; intento++) {
    try {
      fs.renameSync(tmp, ruta);
      return;
    } catch (err) {
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(err.code) || intento >= INTENTOS_RENAME) {
        try { fs.unlinkSync(tmp); } catch {}
        throw err;
      }
      esperaSync(50 * intento);
    }
  }
}

function escribirJsonAtomico(ruta, datos) {
  escribirAtomico(ruta, JSON.stringify(datos, null, 2));
}

module.exports = {
  crearCarpetas, rutaGuion, rutaAudio, rutaImagen, rutaVideo, rutaSubtitulo,
  urlDeRuta, urlAudio, urlImagen, urlVideo, urlCurso,
  escribirAtomico, escribirJsonAtomico,
  DIR_IMAGENES, DIR_REFERENCIAS, DIR_CURSO, DIR_LARGO,
};
