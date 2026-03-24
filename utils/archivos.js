const fs = require('fs');
const path = require('path');

// Rutas base para cada tipo de output
const BASE = path.join(__dirname, '..', 'output');
const DIR_GUIONES    = path.join(BASE, 'guiones');
const DIR_AUDIOS     = path.join(BASE, 'audios');
const DIR_IMAGENES   = path.join(BASE, 'imagenes');
const DIR_VIDEOS     = path.join(BASE, 'videos');
const DIR_SUBTITULOS = path.join(BASE, 'subtitulos');

/**
 * Crea todas las carpetas de output si no existen.
 * Se llama al iniciar el servidor.
 */
function crearCarpetas() {
  [DIR_GUIONES, DIR_AUDIOS, DIR_IMAGENES, DIR_VIDEOS, DIR_SUBTITULOS].forEach(dir => {
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

module.exports = { crearCarpetas, rutaGuion, rutaAudio, rutaImagen, rutaVideo, rutaSubtitulo };
