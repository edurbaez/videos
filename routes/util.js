const express = require('express');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const seg = require('../middleware/seguridad');
const { crearCanal } = require('../lib/sse');
const { cola } = require('../lib/cola');
const { DIR_REFERENCIAS, rutaAudio, urlAudio } = require('../utils/archivos');
const { ts } = require('../utils/log');
const { cargarNicho } = require('../services/nichos');
const { generarGuion } = require('../services/guion');
const { generarCaption } = require('../services/caption');
const { generarAudio } = require('../services/audio');
const { generarImagenesSecuencial, generarImagenesDirectas } = require('../services/imagenes');
const { enviarTexto, enviarFoto, enviarAudio } = require('../services/telegram');

const router = express.Router();
// 'error' kept as alias for the current frontend (guion.html, imagenes.html, audio.html, audios-de-aleman.html)
const canalImagenes = crearCanal('util-imagenes', { aliasError: ['error'] });
const canalAudio    = crearCanal('util-audio', { aliasError: ['error'] });

const uploadRef = multer({
  storage: multer.diskStorage({
    destination: DIR_REFERENCIAS,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.png';
      cb(null, `ref-${uuidv4()}${ext}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/image\/(png|jpeg|webp)/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Solo se aceptan imágenes PNG, JPG o WebP.'));
  },
});

const mensajeDe = err => err?.message || String(err) || 'Error desconocido';

router.post('/util/subir-referencia', seg.limitarGenerar, uploadRef.single('imagen'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo.' });
  // The client's Content-Type is spoofable: check the real magic bytes
  try {
    seg.verificarMagicBytes(req.file.path);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  res.json({ refPath: req.file.path, nombre: req.file.originalname });
});

/** Niche from the request (default 'motivacion'); cargarNicho validates the id (no path traversal). */
const nichoDe = body => cargarNicho(body.nicho === undefined || body.nicho === '' ? 'motivacion' : body.nicho);

router.post('/util/guion', seg.limitarGenerar, async (req, res) => {
  const tema = seg.sanitizarTema(req.body.tema);
  if (!tema) return res.status(400).json({ error: 'El campo "tema" es obligatorio.' });

  let nichoConfig;
  try {
    nichoConfig = nichoDe(req.body);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  try {
    console.log(`[${ts()}] Util/guion: generando para tema="${tema}" nicho=${nichoConfig.id}`);
    const { guion_final } = await generarGuion(tema, 'util-' + Date.now(), nichoConfig);
    const caption = await generarCaption(guion_final, nichoConfig);
    await enviarTexto(`${guion_final}\n\n---\n${caption}`);
    console.log(`[${ts()}] Util/guion: enviado a Telegram.`);
    res.json({ guion: guion_final, caption });
  } catch (err) {
    console.error(`[util/guion] ERROR:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/util/imagenes-progress/:id', canalImagenes.ruta);

/** Emits imagen_lista, sends the photo to Telegram and reports telegram_ok/telegram_error */
const alGuardarImagen = (emit, total, etiqueta, avisarEnvio = false) => async (n, ruta, urlPublica) => {
  emit('imagen_lista', { n, total, urlPublica });
  try {
    if (avisarEnvio) emit('progreso', { mensaje: `Enviando imagen ${n}/${total} a Telegram...` });
    await enviarFoto(ruta);
    emit('telegram_ok', { n });
  } catch (err) {
    console.error(`[${etiqueta}] Error Telegram imagen ${n}:`, err.message);
    emit('telegram_error', { n, mensaje: err.message });
  }
};

router.post('/util/imagenes', seg.limitarGenerar, (req, res) => {
  const tema     = seg.sanitizarTema(req.body.tema);
  const cantidad = seg.validarCantidad(req.body.cantidad ?? 2);
  if (!tema) return res.status(400).json({ error: 'El campo "tema" es obligatorio.' });

  let nichoConfig;
  try {
    nichoConfig = nichoDe(req.body);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const id = 'util-' + uuidv4();
  res.json({ id });
  const emit = canalImagenes.emisor(id);

  cola.ejecutar(id, emit, async () => {
    try {
      console.log(`[${ts()}] Util/imagenes: tema="${tema}" cantidad=${cantidad} nicho=${nichoConfig.id}`);

      emit('progreso', { mensaje: 'Generando guion base...' });
      const { guion_final } = await generarGuion(tema, id, nichoConfig);

      emit('progreso', { mensaje: `Generando ${cantidad} prompts visuales en bloque...` });
      await generarImagenesSecuencial({
        guion: guion_final, cantidad, id, nichoConfig,
        onCadaImagen: alGuardarImagen(emit, cantidad, 'util/imagenes'),
        onPrompt:     (n, prompt) => emit('prompt_imagen', { n, total: cantidad, prompt }),
        onStoryboard: escenas => emit('storyboard_listo', { escenas }),
      });

      emit('finalizado', { total: cantidad });
    } catch (err) {
      console.error(`[util/imagenes] ERROR:`, err.message);
      emit('pipeline_error', { mensaje: mensajeDe(err) });
    }
  }).catch(() => {});
});

router.get('/util/audio-progress/:id', canalAudio.ruta);

router.post('/util/audio', seg.limitarGenerar, (req, res) => {
  const { nicho = 'motivacion', genero, tts, idioma, voz } = req.body;
  const tema = seg.sanitizarTema(req.body.tema);
  if (!tema) return res.status(400).json({ error: 'El campo "tema" es obligatorio.' });

  const id = 'audio-' + uuidv4();
  res.json({ id });
  const emit = canalAudio.emisor(id);

  cola.ejecutar(id, emit, async () => {
    try {
      const nichoConfig = cargarNicho(nicho);
      if (idioma) nichoConfig.idioma = idioma;
      const generoFinal = genero || nichoConfig.defaults.voz || 'masculino';
      const ttsFinal    = tts    || nichoConfig.defaults.tts || 'google';

      emit('progreso', { paso: 1, mensaje: 'Generando guion...' });
      const { guion_final, guion_audio } = await generarGuion(tema, id, nichoConfig);
      emit('guion_listo', { guion: guion_final });

      const proveedorNombre = ttsFinal === 'openai' ? 'OpenAI TTS' : 'Google TTS';
      emit('progreso', { paso: 2, mensaje: `Generando audio (voz ${generoFinal}, ${proveedorNombre})...` });
      const ruta = rutaAudio(id);
      await generarAudio(guion_audio, ruta, generoFinal, ttsFinal, nichoConfig.idioma, voz);
      emit('audio_listo', { url: urlAudio(id) });

      // Telegram: script as text first, then the audio
      emit('progreso', { paso: 3, mensaje: 'Enviando guion a Telegram...' });
      await enviarTexto(guion_final);
      emit('progreso', { paso: 3, mensaje: 'Enviando audio a Telegram...' });
      await enviarAudio(ruta);
      emit('finalizado', { url: urlAudio(id), guion: guion_final });

      console.log(`[${ts()}] Util/audio: completado id=${id}`);
    } catch (err) {
      console.error(`[util/audio] ERROR:`, mensajeDe(err));
      console.error(err?.stack || err);
      emit('pipeline_error', { mensaje: mensajeDe(err) });
    }
  }).catch(() => {});
});

router.post('/util/imagenes-directas', seg.limitarGenerar, (req, res) => {
  const { api = 'google' } = req.body;
  const modelo   = seg.normalizarModeloImagen(req.body.modelo);
  const prompt   = seg.sanitizarTema(req.body.prompt);
  const cantidad = seg.validarCantidad(req.body.cantidad ?? 2);

  if (!prompt) return res.status(400).json({ error: 'El campo "prompt" es obligatorio.' });

  let refImagePath, quality;
  try {
    quality = seg.validarQuality(req.body.quality);
    if (!['openai', 'google'].includes(api)) throw new Error(`API de imagen "${String(api).slice(0, 20)}" no válida.`);
    seg.validarModelo(modelo, api);
    refImagePath = seg.validarRefImagePath(req.body.refImagePath, DIR_REFERENCIAS);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const id = 'util-' + uuidv4();
  res.json({ id });
  const emit = canalImagenes.emisor(id);

  cola.ejecutar(id, emit, async () => {
    try {
      const modeloFinal = modelo || (api === 'google' ? seg.MODELO_IMAGEN_GOOGLE_DEFAULT : seg.MODELO_IMAGEN_OPENAI_DEFAULT);
      const apiNombre = api === 'google' ? 'Google Imagen' : `OpenAI ${modeloFinal}`;
      console.log(`[${ts()}] Util/imagenes-directas: api=${api} modelo=${modeloFinal} cantidad=${cantidad}`);

      emit('progreso', { mensaje: `Generando ${cantidad} imagen${cantidad !== 1 ? 'es' : ''} con ${apiNombre}...` });
      await generarImagenesDirectas(prompt, cantidad, id, modeloFinal, api,
        alGuardarImagen(emit, cantidad, 'util/imagenes-directas', true), refImagePath, quality);

      emit('finalizado', { total: cantidad });
    } catch (err) {
      console.error(`[util/imagenes-directas] ERROR:`, err.message);
      emit('pipeline_error', { mensaje: mensajeDe(err) });
    }
  }).catch(() => {});
});

module.exports = router;
