const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { ts } = require('../utils/log');
const { obtenerDuracionAudio, renderizarAudioEscenas, unirVideoAudio, elegirMusica } = require('./video');

const RAIZ = path.join(__dirname, '..');
const ENTRADA = path.join(RAIZ, 'remotion', 'index.jsx');
const DIR_PUBLICO = path.join(RAIZ, 'remotion', 'public');
const COMPOSICION = 'Largo';
// Remotion captures every 1080p frame in headless Chrome: ~4–5x realtime on a 4-core laptop vs ~1x for FFmpeg
const RENDER_DEFAULT = 'ffmpeg';
const ARCHIVO_IMAGEN = /^[\w.-]{1,120}\.(png|jpe?g|webp)$/i;
const TIPOS = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

/** 'remotion' | 'ffmpeg' from LARGO_RENDER. */
function modoRender() {
  const v = String(process.env.LARGO_RENDER || RENDER_DEFAULT).trim().toLowerCase();
  return v === 'remotion' ? 'remotion' : 'ffmpeg';
}

let bundlePromesa = null;

/** Webpack bundle of remotion/, built once per process (~10–20 s) and reused by every render. */
function obtenerBundle() {
  if (!bundlePromesa) {
    const { bundle } = require('@remotion/bundler');
    const t0 = Date.now();
    // Fixed outDir: rebuilt on each process start instead of leaving one temp folder per restart
    const outDir = path.join(os.tmpdir(), 'videos-remotion-bundle');
    bundlePromesa = bundle({ entryPoint: ENTRADA, publicDir: DIR_PUBLICO, rootDir: RAIZ, outDir })
      .then(ubicacion => {
        console.log(`[${ts()}] Remotion: bundle listo en ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        return ubicacion;
      })
      .catch(err => { bundlePromesa = null; throw err; });
  }
  return bundlePromesa;
}

/**
 * Static server for the job's images only: 127.0.0.1, random port, random path token, flat file
 * names (no separators) resolved inside `dir`. Closed after the render.
 */
function servirImagenes(dir) {
  const raiz = path.resolve(dir);
  const token = crypto.randomBytes(16).toString('hex');
  const servidor = http.createServer((req, res) => {
    const partes = (req.url || '').split('?')[0].split('/');
    let nombre = '';
    try { nombre = decodeURIComponent(partes[2] || ''); } catch { /* malformed → 404 */ }
    const ruta = path.resolve(raiz, nombre);
    if (req.method !== 'GET' || partes.length !== 3 || partes[1] !== token || !ARCHIVO_IMAGEN.test(nombre)
      || path.dirname(ruta) !== raiz || !fs.existsSync(ruta)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': TIPOS[path.extname(ruta).toLowerCase()], 'Cache-Control': 'max-age=3600' });
    fs.createReadStream(ruta).on('error', () => res.destroy()).pipe(res);
  });
  return new Promise((resolve, reject) => {
    servidor.once('error', reject);
    servidor.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${servidor.address().port}/${token}`,
      cerrar: () => new Promise(r => { servidor.closeAllConnections?.(); servidor.close(() => r()); }),
    }));
  });
}

/**
 * Renders the long video with Remotion (silent) while the FFmpeg audio chain (music + ducking +
 * loudnorm) runs in parallel, then muxes both without re-encoding.
 *
 * @param {object} props - output of construirLineaTiempo (escenas[].archivo are file names inside dirImagenes)
 * @param {object} o - { rutaAudio, rutaDestino, dirImagenes, dirTrabajo, musica?, onProgreso?(0..1) }
 */
async function generarVideoRemotion(props, { rutaAudio, rutaDestino, dirImagenes, dirTrabajo, musica, onProgreso }) {
  const { selectComposition, renderMedia } = require('@remotion/renderer');
  const t0 = Date.now();
  const duracion = await obtenerDuracionAudio(rutaAudio);
  const pista = musica === undefined ? elegirMusica(path.basename(rutaDestino)) : (musica || null);
  const dir = path.join(dirTrabajo, `remotion-${path.basename(rutaDestino, path.extname(rutaDestino))}`);
  fs.mkdirSync(dir, { recursive: true });
  const rutaVideo = path.join(dir, 'video.mp4');
  const rutaAudioFinal = path.join(dir, 'audio.m4a');

  const raizImg = path.resolve(dirImagenes);
  const escenas = props.escenas.map(e => {
    const valido = e.archivo && ARCHIVO_IMAGEN.test(e.archivo) && fs.existsSync(path.join(raizImg, e.archivo));
    return { ...e, archivo: valido ? e.archivo : null };
  });
  if (!escenas.some(e => e.archivo)) throw new Error('Remotion: ninguna escena tiene imagen válida.');

  const servidor = await servirImagenes(raizImg);
  try {
    const inputProps = { ...props, escenas, baseImagenes: servidor.url };
    fs.writeFileSync(path.join(dirTrabajo, 'remotion-props.json'), JSON.stringify(inputProps), 'utf-8');
    const serveUrl = await obtenerBundle();
    const composition = await selectComposition({ serveUrl, id: COMPOSICION, inputProps, logLevel: 'error' });
    console.log(`[${ts()}] Remotion: ${composition.durationInFrames} frames @${composition.fps}fps, ${escenas.length} escenas, ${props.tarjetas.length} tarjetas${pista ? `, música ${path.basename(pista)}` : ''}`);

    let ultimo = -1;
    const video = renderMedia({
      composition, serveUrl, inputProps,
      codec: 'h264', muted: true, outputLocation: rutaVideo,
      imageFormat: 'jpeg', jpegQuality: 90, crf: 23, x264Preset: 'veryfast', pixelFormat: 'yuv420p', colorSpace: 'bt709',
      concurrency: Math.min(os.cpus().length, parseInt(process.env.LARGO_REMOTION_CONCURRENCIA) || os.cpus().length),
      // ANGLE (GPU) was ~35% faster than the software default on a 4-core Windows laptop
      chromiumOptions: { gl: process.env.LARGO_REMOTION_GL || (process.platform === 'win32' ? 'angle' : null) },
      logLevel: 'error',
      onProgress: ({ progress }) => {
        const pct = Math.floor(progress * 100);
        if (pct >= ultimo + 5) {
          ultimo = pct;
          console.log(`[${ts()}] Remotion: ${pct}%`);
          if (onProgreso) onProgreso(progress);
        }
      },
    });
    await Promise.all([video, renderizarAudioEscenas(rutaAudio, rutaAudioFinal, duracion, pista)]);
    await unirVideoAudio(['-i', rutaVideo], rutaAudioFinal, duracion, rutaDestino);
  } finally {
    await servidor.cerrar();
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
  const seg = (Date.now() - t0) / 1000;
  console.log(`[${ts()}] Remotion: listo en ${seg.toFixed(0)}s (${(seg / duracion).toFixed(2)}x la duración)`);
  return rutaDestino;
}

module.exports = { generarVideoRemotion, modoRender, obtenerBundle, servirImagenes };
