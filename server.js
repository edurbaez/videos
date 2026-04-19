require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const multer = require('multer');
const { crearCarpetas, rutaAudio, rutaVideo, rutaSubtitulo, DIR_REFERENCIAS } = require('./utils/archivos');
const seg = require('./middleware/seguridad');
const { leerHistorial, guardarEntrada } = require('./utils/historial');
const { listarNichos, cargarNicho } = require('./services/nichos');
const { generarGuion } = require('./services/guion');
const { generarCaption } = require('./services/caption');
const { generarAudio } = require('./services/audio');
const { generarImagenes, generarImagenesSecuencial, generarImagenesDirectas, obtenerGaleria } = require('./services/imagenes');
const { generarVideo } = require('./services/video');
const { generarSubtitulos } = require('./services/subtitulos');
const { enviarATelegram, enviarTexto, enviarFotos, enviarFoto, enviarAudio } = require('./services/telegram');
const yt = require('./services/youtube');

// ── Inicialización ────────────────────────────────────────────────────────────
crearCarpetas();

// Directorio para el servicio de videos de curso
const DIR_CURSO = path.join(__dirname, 'output', 'curso');
fs.mkdirSync(DIR_CURSO, { recursive: true });

// Voces Google TTS por idioma y género (espejo de services/audio.js)
const CURSO_VOCES_GOOGLE = {
  de: { masculino: 'de-DE-Neural2-B', femenino: 'de-DE-Neural2-A' },
  en: { masculino: 'en-US-Neural2-D', femenino: 'en-US-Neural2-F' },
  es: { masculino: 'es-US-Neural2-B', femenino: 'es-US-Neural2-A' },
  fr: { masculino: 'fr-FR-Neural2-B', femenino: 'fr-FR-Neural2-A' },
  pt: { masculino: 'pt-BR-Neural2-B', femenino: 'pt-BR-Neural2-A' },
};
const CURSO_LANG_CODE = {
  de: 'de-DE', en: 'en-US', es: 'es-US', fr: 'fr-FR', pt: 'pt-BR',
};
const CURSO_LANG_NAMES = {
  de: 'German (Deutsch)', en: 'English', es: 'Spanish (Español)',
  fr: 'French (Français)', pt: 'Portuguese (Português)',
};

/** Devuelve el siguiente número de secuencia disponible en output/curso/ */
function cursosiguienteNumero() {
  const archivos = fs.existsSync(DIR_CURSO) ? fs.readdirSync(DIR_CURSO) : [];
  const nums = archivos
    .map(f => { const m = f.match(/^(audio|video)(\d+)\.(mp3|txt|mp4)$/); return m ? parseInt(m[2]) : 0; })
    .filter(n => n > 0);
  return nums.length ? Math.max(...nums) + 1 : 1;
}

/** Lista todos los archivos de curso ordenados por número descendente */
function cursoListarArchivos() {
  if (!fs.existsSync(DIR_CURSO)) return [];
  const archivos = fs.readdirSync(DIR_CURSO);
  const nums = new Set();
  archivos.forEach(f => { const m = f.match(/^(audio|video)(\d+)\.(mp3|txt|mp4)$/); if (m) nums.add(parseInt(m[2])); });
  return [...nums].sort((a, b) => b - a).map(n => {
    const txtPath   = path.join(DIR_CURSO, `audio${n}.txt`);
    const videoPath = path.join(DIR_CURSO, `video${n}.mp4`);
    let texto = '';
    try { texto = fs.readFileSync(txtPath, 'utf-8'); } catch {}
    return {
      numero: n,
      mp3:   `/output/curso/audio${n}.mp3`,
      txt:   `/output/curso/audio${n}.txt`,
      video: fs.existsSync(videoPath) ? `/output/curso/video${n}.mp4` : null,
      texto,
    };
  });
}

// Multer para subida de imagen de referencia
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

const app = express();

// CORS: acepta solo el origen configurado en CORS_ORIGIN (o localhost en dev)
app.use(cors({
  origin: process.env.CORS_ORIGIN || `http://localhost:${process.env.PORT || 3000}`,
}));

// Rate limiting global + autenticación por API Key
app.use(seg.limitarGlobal);
app.use(seg.validarApiKey);

app.use(express.json());

// Servir archivos estáticos del frontend y del directorio output
app.use(express.static(path.join(__dirname, 'public')));
app.use('/output', express.static(path.join(__dirname, 'output')));

// SSE clients del pipeline principal
const sseClients = new Map();
// Promesas en espera de confirmación de guion editado: id → { resolve, reject }
const pendingContinuar = new Map();
// SSE clients del servicio de videos de curso
const sseCursoClients = new Map();
// SSE clients de la utilidad de imágenes
const sseImgClients = new Map();
// SSE clients de la utilidad de audio
const sseAudioClients = new Map();

/**
 * Emite un evento SSE al cliente registrado para ese ID.
 * Si el cliente ya no está conectado, lo ignora.
 */
function emitirEvento(id, evento, datos) {
  const ts = () => new Date().toTimeString().slice(0, 8);
  const cliente = sseClients.get(id);
  if (!cliente) return;
  try {
    cliente.write(`event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`);
    console.log(`[${ts()}] SSE [${id}]: evento "${evento}" emitido.`);
  } catch (e) {
    console.warn(`[${ts()}] SSE [${id}]: no se pudo emitir evento (cliente desconectado).`);
  }
}

// ── POST /util/subir-referencia — Subir imagen de referencia ─────────────────
app.post('/util/subir-referencia', seg.limitarGenerar, uploadRef.single('imagen'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo.' });
  // Verificar magic bytes reales (el Content-Type del cliente es manipulable)
  try {
    seg.verificarMagicBytes(req.file.path);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  res.json({ refPath: req.file.path, nombre: req.file.originalname });
});

// ── GET /progreso/:id — SSE ───────────────────────────────────────────────────
app.get('/progreso/:id', (req, res) => {
  const { id } = req.params;

  if (sseClients.size >= seg.MAX_SSE_CLIENTES) {
    return res.status(429).json({ error: 'Demasiadas conexiones activas. Intenta más tarde.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.set(id, res);

  // Enviar heartbeat cada 20s para mantener la conexión viva
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch {}
  }, 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(id);
  });
});

// ── POST /continuar/:id — Confirmar guion editado y reanudar pipeline ────────
app.post('/continuar/:id', (req, res) => {
  const { id } = req.params;
  const pending = pendingContinuar.get(id);
  if (!pending) return res.status(404).json({ error: 'No hay pipeline en espera para este ID.' });
  const guion = typeof req.body.guion === 'string' ? req.body.guion.trim().slice(0, 5000) : null;
  if (!guion) return res.status(400).json({ error: 'El campo "guion" es obligatorio.' });
  pending.resolve(guion);
  pendingContinuar.delete(id);
  res.json({ ok: true });
});

// ── POST /generar — Pipeline principal ───────────────────────────────────────
app.post('/generar', seg.limitarGenerar, async (req, res) => {
  const ts = () => new Date().toTimeString().slice(0, 8);
  const {
    nicho       = 'motivacion',
    genero,
    modelo,
    api         = 'openai',
    subtitulos  = false,
    tts,
    estilo,
    escenario,
    quality     = 'medium',
    editarGuion = false,
  } = req.body;

  // Sanitización de inputs del usuario
  const tema     = seg.sanitizarTema(req.body.tema);
  const cantidad = seg.validarCantidad(req.body.cantidad, 20);

  if (!tema) {
    return res.status(400).json({ error: 'El campo "tema" es obligatorio.' });
  }

  // Validar modelo antes de usarlo en URLs de API (anti-SSRF)
  try {
    seg.validarModelo(modelo, api);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // Validar refImagePath: debe estar dentro de output/referencias/
  let refImagePath = null;
  try {
    refImagePath = seg.validarRefImagePath(req.body.refImagePath, DIR_REFERENCIAS);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // YouTube upload (opcional)
  const subirYoutube = req.body.subirYoutube === true || req.body.subirYoutube === 'true';
  const privacidadYoutube = ['public', 'unlisted', 'private'].includes(req.body.privacidadYoutube)
    ? req.body.privacidadYoutube : 'private';
  let canalYoutube = null;
  if (subirYoutube) {
    const canalesConf = yt.listarCanalesConfig();
    const canalEncontrado = canalesConf.find(c => c.nombre === req.body.canalYoutube);
    if (!canalEncontrado) {
      return res.status(400).json({ error: `Canal YouTube "${req.body.canalYoutube}" no encontrado en youtube-channels.json.` });
    }
    if (!canalEncontrado.autorizado) {
      return res.status(400).json({ error: `Canal "${canalEncontrado.label}" no autorizado. Visita /youtube/auth?canal=${canalEncontrado.nombre}` });
    }
    canalYoutube = canalEncontrado.nombre;
  }

  // Cargar config del nicho — falla rápido si el nicho no existe
  let nichoConfig;
  try {
    nichoConfig = cargarNicho(nicho);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // Fusionar defaults del nicho con los parámetros enviados por el usuario
  const vozFinal      = genero   || nichoConfig.defaults.voz       || 'femenino';
  const modeloFinal   = modelo   || nichoConfig.defaults.modeloImagen || 'gpt-image-1';
  const apiFinal      = api      || nichoConfig.defaults.apiImagen  || 'openai';
  const ttsFinal      = tts      || nichoConfig.defaults.tts        || 'google';
  const estiloFinal   = estilo   || nichoConfig.defaults.estilo     || 'cinematico';
  const escenarioFinal = escenario || nichoConfig.defaults.escenario || 'ninguno';

  const id = uuidv4();
  console.log(`\n[${ts()}] === NUEVA GENERACIÓN id=${id} nicho=${nicho} tema="${tema}" imágenes=${cantidad} voz=${vozFinal} tts=${ttsFinal} modelo=${modeloFinal} estilo=${estiloFinal} escenario=${escenarioFinal} ===`);

  // Respuesta inmediata con el ID para que el frontend abra el SSE
  res.json({ id });

  // Ejecutar pipeline de forma asíncrona (no bloqueante para el cliente)
  (async () => {
    try {
      // ── PASO 1: Guion ────────────────────────────────────────────────────
      console.log(`[${ts()}] Pipeline: paso 1 — guion`);
      const { guion_final, guion_audio } = await generarGuion(tema, id, nichoConfig);
      emitirEvento(id, 'guion_listo', { guion_final });

      // ── PAUSA OPCIONAL: esperar confirmación del usuario para editar guion ──
      let guionParaPipeline = guion_final;
      let guionAudioParaPipeline = guion_audio;
      if (editarGuion) {
        console.log(`[${ts()}] Pipeline: esperando confirmación de guion (editarGuion=true)`);
        guionParaPipeline = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingContinuar.delete(id);
            reject(new Error('Tiempo de espera agotado para confirmación del guion (10 min).'));
          }, 10 * 60 * 1000);
          pendingContinuar.set(id, {
            resolve: (g) => { clearTimeout(timer); resolve(g); },
            reject:  (e) => { clearTimeout(timer); reject(e); },
          });
        });
        guionAudioParaPipeline = guionParaPipeline;
        console.log(`[${ts()}] Pipeline: guion confirmado, reanudando`);
        emitirEvento(id, 'guion_confirmado', {});
      }

      // ── PASO 2: Caption + (Audio → Subtítulos) + Imágenes en paralelo ──────
      console.log(`[${ts()}] Pipeline: paso 2 — caption, audio+subtítulos, imágenes en paralelo`);
      const [caption, rutaSRT, rutasImagenes] = await Promise.all([

        // Caption
        generarCaption(guionParaPipeline, nichoConfig).then(c => {
          emitirEvento(id, 'caption_listo', { caption: c });
          return c;
        }),

        // Audio → (Subtítulos si están activados)
        generarAudio(guionAudioParaPipeline, rutaAudio(id), vozFinal, ttsFinal, nichoConfig.idioma).then(async () => {
          emitirEvento(id, 'audio_listo', { ruta: `/output/audios/audio-${id}.mp3` });
          if (!subtitulos) {
            emitirEvento(id, 'subtitulos_listos', {});
            return null;
          }
          emitirEvento(id, 'subtitulos_generando', {});
          try {
            const srt = await generarSubtitulos(rutaAudio(id), rutaSubtitulo(id));
            emitirEvento(id, 'subtitulos_listos', {});
            return srt;
          } catch (errSRT) {
            console.warn(`[${ts()}] Subtítulos: fallo (${errSRT.message}), se continúa sin subtítulos.`);
            emitirEvento(id, 'subtitulos_listos', {});
            return null;
          }
        }),

        // Imágenes
        generarImagenes(guionParaPipeline, parseInt(cantidad), id, (n, prompt) => {
          emitirEvento(id, 'prompt_imagen', { n, total: parseInt(cantidad), prompt });
        }, modeloFinal, apiFinal, estiloFinal, escenarioFinal, (escenas) => {
          emitirEvento(id, 'storyboard_listo', { escenas });
        }, (n, mensaje) => {
          emitirEvento(id, 'error_imagen', { n, mensaje });
        }, nichoConfig, refImagePath, quality).then(rutas => {
          const urlsImagenes = rutas.map((_, i) => `/output/imagenes/imagen-${id}-${i + 1}.png`);
          emitirEvento(id, 'imagenes_listas', { rutas: urlsImagenes });
          return rutas;
        }),
      ]);

      // ── PASO 3: Video ────────────────────────────────────────────────────
      console.log(`[${ts()}] Pipeline: paso 3 — video con subtítulos`);
      await generarVideo(rutaAudio(id), rutasImagenes, rutaVideo(id), rutaSRT);
      emitirEvento(id, 'video_listo', { ruta: `/output/videos/video-${id}.mp4` });

      // ── PASO 4: Telegram ─────────────────────────────────────────────────
      console.log(`[${ts()}] Pipeline: paso 4 — telegram`);
      try {
        await enviarATelegram(rutaVideo(id), caption);
        emitirEvento(id, 'telegram_listo', { ok: true });
      } catch (errTg) {
        console.error(`[${ts()}] Telegram ERROR [${id}]:`, errTg.message);
        emitirEvento(id, 'telegram_error_video', { mensaje: errTg.message });
      }

      // ── PASO 5: YouTube (opcional) ───────────────────────────────────────
      let youtubeResult = null;
      if (subirYoutube) {
        try {
          emitirEvento(id, 'youtube_subiendo', {});
          console.log(`[${ts()}] YouTube: generando metadatos...`);
          const meta = await yt.generarMetadatosShorts(tema, guionParaPipeline, nichoConfig.nombre);
          emitirEvento(id, 'youtube_metadatos', { titulo: meta.titulo, descripcion: meta.descripcion, tags: meta.tags });
          console.log(`[${ts()}] YouTube: subiendo video al canal "${canalYoutube}"...`);
          youtubeResult = await yt.subirVideo({
            rutaVideo:   rutaVideo(id),
            titulo:      meta.titulo,
            descripcion: meta.descripcion,
            tags:        meta.tags,
            canal:       canalYoutube,
            privacidad:  privacidadYoutube,
          });
          emitirEvento(id, 'youtube_listo', { url: youtubeResult.url, videoId: youtubeResult.videoId });
          console.log(`[${ts()}] YouTube: publicado → ${youtubeResult.url}`);
        } catch (errYT) {
          console.error(`[${ts()}] YouTube ERROR [${id}]:`, errYT.message);
          emitirEvento(id, 'youtube_error', { mensaje: errYT.message });
        }
      }

      // ── PASO 6: Historial ────────────────────────────────────────────────
      const cantidadNum = parseInt(cantidad);
      guardarEntrada({
        id,
        tema,
        nicho,
        nombreNicho: nichoConfig.nombre,
        caption,
        guion: guionParaPipeline,
        fecha: new Date().toISOString(),
        parametros: {
          voz:      vozFinal,
          tts:      ttsFinal,
          modelo:   modeloFinal,
          api:      apiFinal,
          estilo:   estiloFinal,
          escenario: escenarioFinal,
          cantidad: cantidadNum,
        },
        rutas: {
          audio: `/output/audios/audio-${id}.mp3`,
          imagenes: Array.from({ length: cantidadNum }, (_, i) => `/output/imagenes/imagen-${id}-${i + 1}.png`),
          video: `/output/videos/video-${id}.mp4`,
        },
      });

      // Evento final con todos los datos para el frontend
      emitirEvento(id, 'finalizado', {
        id,
        guion: guionParaPipeline,
        caption,
        audio: `/output/audios/audio-${id}.mp3`,
        imagenes: Array.from({ length: cantidadNum }, (_, i) => `/output/imagenes/imagen-${id}-${i + 1}.png`),
        video: `/output/videos/video-${id}.mp4`,
        ...(youtubeResult ? { youtubeUrl: youtubeResult.url } : {}),
      });

      console.log(`[${ts()}] Pipeline: generación ${id} completada con éxito.`);

    } catch (err) {
      const mensaje = err?.message || String(err) || 'Error desconocido';
      console.error(`[${ts()}] Pipeline ERROR [${id}]:`, mensaje);
      console.error(err?.stack || err);
      emitirEvento(id, 'error_pipeline', { mensaje });
    }
  })();
});

// ── GET /nichos ────────────────────────────────────────────────────────────
app.get('/nichos', (req, res) => {
  res.json(listarNichos());
});

// ── GET /historial ─────────────────────────────────────────────────────────
app.get('/historial', (req, res) => {
  res.json(leerHistorial());
});

// ── GET /galeria ───────────────────────────────────────────────────────────
app.get('/galeria', (req, res) => {
  res.json(obtenerGaleria());
});

// ── POST /util/guion — Solo guion → Telegram ──────────────────────────────
app.post('/util/guion', seg.limitarGenerar, async (req, res) => {
  const ts = () => new Date().toTimeString().slice(0, 8);
  const tema = seg.sanitizarTema(req.body.tema);
  if (!tema) return res.status(400).json({ error: 'El campo "tema" es obligatorio.' });

  try {
    const nichoConfig = cargarNicho('motivacion');
    console.log(`[${ts()}] Util/guion: generando para tema="${tema}"`);
    const { guion_final } = await generarGuion(tema, 'util-' + Date.now(), nichoConfig);
    const caption = await generarCaption(guion_final, nichoConfig);
    const texto = `${guion_final}\n\n---\n${caption}`;
    await enviarTexto(texto);
    console.log(`[${ts()}] Util/guion: enviado a Telegram.`);
    res.json({ guion: guion_final, caption });
  } catch (err) {
    console.error(`[util/guion] ERROR:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /util/imagenes-progress/:id — SSE para imágenes ──────────────────
app.get('/util/imagenes-progress/:id', (req, res) => {
  const { id } = req.params;

  if (sseImgClients.size >= seg.MAX_SSE_CLIENTES) {
    return res.status(429).json({ error: 'Demasiadas conexiones activas. Intenta más tarde.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseImgClients.set(id, res);
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 20000);
  req.on('close', () => { clearInterval(hb); sseImgClients.delete(id); });
});

// ── POST /util/imagenes — Solo imágenes → Telegram (secuencial + SSE) ────
app.post('/util/imagenes', seg.limitarGenerar, async (req, res) => {
  const ts = () => new Date().toTimeString().slice(0, 8);
  const tema     = seg.sanitizarTema(req.body.tema);
  const cantidad = seg.validarCantidad(req.body.cantidad ?? 2);
  if (!tema) return res.status(400).json({ error: 'El campo "tema" es obligatorio.' });

  const id = 'util-' + uuidv4();
  res.json({ id });

  (async () => {
    const emit = (evento, datos) => {
      const cliente = sseImgClients.get(id);
      if (cliente) try { cliente.write(`event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`); } catch {}
    };

    try {
      const nichoConfig = cargarNicho('motivacion');
      const cantNum = cantidad; // ya validado con validarCantidad()
      console.log(`[${ts()}] Util/imagenes: tema="${tema}" cantidad=${cantNum}`);

      emit('progreso', { mensaje: 'Generando guion base...' });
      const { guion_final } = await generarGuion(tema, id, nichoConfig);

      emit('progreso', { mensaje: `Generando ${cantNum} prompts visuales en bloque...` });

      await generarImagenesSecuencial(guion_final, cantNum, id, async (n, ruta, urlPublica) => {
        emit('imagen_lista', { n, total: cantNum, urlPublica });
        try {
          await enviarFoto(ruta);
          emit('telegram_ok', { n });
        } catch (err) {
          console.error(`[util/imagenes] Error Telegram imagen ${n}:`, err.message);
          emit('telegram_error', { n, mensaje: err.message });
        }
      }, (n, prompt) => {
        emit('prompt_imagen', { n, total: cantNum, prompt });
      }, 'cinematico', 'ninguno', (escenas) => {
        emit('storyboard_listo', { escenas });
      }, nichoConfig);

      emit('finalizado', { total: cantNum });
    } catch (err) {
      console.error(`[util/imagenes] ERROR:`, err.message);
      emit('error', { mensaje: err.message });
    }
  })();
});

// ── GET /util/audio-progress/:id — SSE para audio ────────────────────────────
app.get('/util/audio-progress/:id', (req, res) => {
  const { id } = req.params;

  if (sseAudioClients.size >= seg.MAX_SSE_CLIENTES) {
    return res.status(429).json({ error: 'Demasiadas conexiones activas. Intenta más tarde.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseAudioClients.set(id, res);
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 20000);
  req.on('close', () => { clearInterval(hb); sseAudioClients.delete(id); });
});

// ── POST /util/audio — Tema → Guion → Audio Google TTS → Telegram ─────────────
app.post('/util/audio', seg.limitarGenerar, async (req, res) => {
  const ts = () => new Date().toTimeString().slice(0, 8);
  const { nicho = 'motivacion', genero, tts, idioma, voz } = req.body;
  const tema = seg.sanitizarTema(req.body.tema);
  if (!tema) return res.status(400).json({ error: 'El campo "tema" es obligatorio.' });

  const id = 'audio-' + uuidv4();
  res.json({ id });

  (async () => {
    const emit = (evento, datos) => {
      const cliente = sseAudioClients.get(id);
      if (cliente) try { cliente.write(`event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`); } catch {}
    };

    try {
      const nichoConfig = cargarNicho(nicho);
      if (idioma) nichoConfig.idioma = idioma;
      const generoFinal = genero || nichoConfig.defaults.voz  || 'masculino';
      const ttsFinal    = tts    || nichoConfig.defaults.tts  || 'google';
      // Paso 1: Guion
      emit('progreso', { paso: 1, mensaje: 'Generando guion...' });
      const { guion_final, guion_audio } = await generarGuion(tema, id, nichoConfig);
      emit('guion_listo', { guion: guion_final });

      // Paso 2: Audio
      const proveedorNombre = ttsFinal === 'openai' ? 'OpenAI TTS' : 'Google TTS';
      emit('progreso', { paso: 2, mensaje: `Generando audio (voz ${generoFinal}, ${proveedorNombre})...` });
      const ruta = rutaAudio(id);
      await generarAudio(guion_audio, ruta, generoFinal, ttsFinal, nichoConfig.idioma, voz);
      const urlAudio = `/output/audios/audio-${id}.mp3`;
      emit('audio_listo', { url: urlAudio });

      // Paso 3: Telegram — primero el guion como texto, luego el audio
      emit('progreso', { paso: 3, mensaje: 'Enviando guion a Telegram...' });
      await enviarTexto(guion_final);
      emit('progreso', { paso: 3, mensaje: 'Enviando audio a Telegram...' });
      await enviarAudio(ruta);
      emit('finalizado', { url: urlAudio, guion: guion_final });

      console.log(`[${ts()}] Util/audio: completado id=${id}`);
    } catch (err) {
      const mensaje = err?.message || String(err) || 'Error desconocido';
      console.error(`[util/audio] ERROR:`, mensaje);
      console.error(err?.stack || err);
      emit('error', { mensaje });
    }
  })();
});

// ── POST /util/imagenes-directas — Prompt directo → imágenes (Google o OpenAI) + Telegram ──
app.post('/util/imagenes-directas', seg.limitarGenerar, async (req, res) => {
  const ts = () => new Date().toTimeString().slice(0, 8);
  const { modelo, api = 'google', quality = 'medium' } = req.body;
  const prompt   = seg.sanitizarTema(req.body.prompt);
  const cantidad = seg.validarCantidad(req.body.cantidad ?? 2);

  if (!prompt) return res.status(400).json({ error: 'El campo "prompt" es obligatorio.' });

  // Validar modelo (anti-SSRF)
  try {
    seg.validarModelo(modelo, api);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // Validar refImagePath
  let refImagePath = null;
  try {
    refImagePath = seg.validarRefImagePath(req.body.refImagePath, DIR_REFERENCIAS);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const id = 'util-' + uuidv4();
  res.json({ id });

  (async () => {
    const emit = (evento, datos) => {
      const cliente = sseImgClients.get(id);
      if (cliente) try { cliente.write(`event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`); } catch {}
    };

    try {
      const cantNum = cantidad; // ya validado con validarCantidad()
      const modeloFinal = modelo || (api === 'google' ? 'imagen-3.0-generate-002' : 'gpt-image-1');
      const apiNombre = api === 'google' ? 'Google Imagen' : 'OpenAI gpt-image-1';
      console.log(`[${ts()}] Util/imagenes-directas: api=${api} modelo=${modeloFinal} cantidad=${cantNum}`);

      emit('progreso', { mensaje: `Generando ${cantNum} imagen${cantNum !== 1 ? 'es' : ''} con ${apiNombre}...` });

      await generarImagenesDirectas(prompt, cantNum, id, modeloFinal, api, async (n, ruta, urlPublica) => {
        emit('imagen_lista', { n, total: cantNum, urlPublica });
        try {
          emit('progreso', { mensaje: `Enviando imagen ${n}/${cantNum} a Telegram...` });
          await enviarFoto(ruta);
          emit('telegram_ok', { n });
          console.log(`[${ts()}] Imagen ${n}/${cantNum} enviada a Telegram.`);
        } catch (err) {
          console.error(`[util/imagenes-directas] Error Telegram imagen ${n}:`, err.message);
          emit('telegram_error', { n, mensaje: err.message });
        }
      }, refImagePath, quality);

      emit('finalizado', { total: cantNum });
    } catch (err) {
      console.error(`[util/imagenes-directas] ERROR:`, err.message);
      emit('error', { mensaje: err.message });
    }
  })();
});

// ── POST /reenviar/:id ─────────────────────────────────────────────────────
app.post('/reenviar/:id', async (req, res) => {
  const ts = () => new Date().toTimeString().slice(0, 8);
  const { id } = req.params;

  const historial = leerHistorial();
  const entrada = historial.find(e => e.id === id);

  if (!entrada) {
    return res.status(404).json({ error: 'Entrada no encontrada en el historial.' });
  }

  try {
    console.log(`[${ts()}] Reenvío: enviando id=${id} a Telegram...`);
    await enviarATelegram(
      path.join(__dirname, entrada.rutas.video.replace(/^\//, '')),
      entrada.caption
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(`[${ts()}] Reenvío ERROR [${id}]:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /curso/archivos ────────────────────────────────────────────────────────
app.get('/curso/archivos', (req, res) => {
  res.json(cursoListarArchivos());
});

// ── GET /curso/progreso/:id — SSE para el pipeline de curso ───────────────────
app.get('/curso/progreso/:id', (req, res) => {
  const { id } = req.params;
  if (sseCursoClients.size >= seg.MAX_SSE_CLIENTES) {
    return res.status(429).json({ error: 'Demasiadas conexiones activas.' });
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseCursoClients.set(id, res);
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 20000);
  req.on('close', () => { clearInterval(hb); sseCursoClients.delete(id); });
});

// ── POST /curso/generar — Guion OpenAI + Audio Google TTS → output/curso/ ─────
app.post('/curso/generar', seg.limitarGenerar, async (req, res) => {
  const ts = () => new Date().toTimeString().slice(0, 8);
  const tema    = seg.sanitizarTema(req.body.tema);
  const idioma  = ['de', 'en', 'es', 'fr', 'pt'].includes(req.body.idioma) ? req.body.idioma : 'de';
  const genero  = req.body.genero === 'femenino' ? 'femenino' : 'masculino';
  const nivel            = ['A1','A2','B1','B2','C1','C2'].includes(req.body.nivel) ? req.body.nivel : 'B1';
  const palabras         = req.body.palabras ? String(req.body.palabras).trim().slice(0, 300) : '';
  const modo             = req.body.modo === 'video' ? 'video' : 'audio';
  const cantidadImagenes = seg.validarCantidad(req.body.cantidadImagenes ?? 3, 5);
  const apiImagen        = ['openai', 'google'].includes(req.body.apiImagen) ? req.body.apiImagen : 'openai';
  const MODELOS_IMG_OPENAI = ['gpt-image-1', 'gpt-image-1-mini'];
  const modeloImagen = apiImagen === 'google'
    ? 'imagen-3.0-generate-002'
    : (MODELOS_IMG_OPENAI.includes(req.body.modeloImagen) ? req.body.modeloImagen : 'gpt-image-1-mini');
  // Prompt personalizado: se acepta si viene del frontend (máx. 3000 chars)
  const promptPersonalizado = req.body.promptPersonalizado
    ? String(req.body.promptPersonalizado).trim().slice(0, 3000)
    : null;
  // Prompt de humanización: revisión del guion antes de sintetizar audio
  const promptHumanizacion = req.body.promptHumanizacion
    ? String(req.body.promptHumanizacion).trim().slice(0, 3000)
    : null;

  // YouTube upload (opcional, solo en modo video)
  const subirYoutube     = (req.body.subirYoutube === true || req.body.subirYoutube === 'true') && modo === 'video';
  const privacidadYoutube = ['public', 'unlisted', 'private'].includes(req.body.privacidadYoutube)
    ? req.body.privacidadYoutube : 'private';
  let canalYoutube = null;
  if (subirYoutube) {
    const canalesConf = yt.listarCanalesConfig();
    const canalEncontrado = canalesConf.find(c => c.nombre === req.body.canalYoutube);
    if (!canalEncontrado) {
      return res.status(400).json({ error: `Canal YouTube "${req.body.canalYoutube}" no encontrado en youtube-channels.json.` });
    }
    if (!canalEncontrado.autorizado) {
      return res.status(400).json({ error: `Canal "${canalEncontrado.label}" no autorizado. Visita /youtube/auth?canal=${canalEncontrado.nombre}` });
    }
    canalYoutube = canalEncontrado.nombre;
  }

  if (!tema) return res.status(400).json({ error: 'El campo "tema" es obligatorio.' });

  const id = 'curso-' + uuidv4();
  res.json({ id });

  (async () => {
    const emit = (evento, datos) => {
      const cliente = sseCursoClients.get(id);
      if (cliente) try { cliente.write(`event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`); } catch {}
    };

    try {
      // ── PASO 1: Número de secuencia ───────────────────────────────────────
      const numero = cursosiguienteNumero();
      const rutaTxt = path.join(DIR_CURSO, `audio${numero}.txt`);
      const rutaMp3 = path.join(DIR_CURSO, `audio${numero}.mp3`);
      const langName = CURSO_LANG_NAMES[idioma];

      emit('progreso', { paso: 1, mensaje: `Generando guion en ${langName}...` });
      console.log(`[${ts()}] Curso: generando audio${numero} idioma=${idioma} genero=${genero} tema="${tema}"`);

      // ── PASO 2: Guion con OpenAI ──────────────────────────────────────────
      const palabrasLine = palabras ? `- Naturally incorporate these words or phrases: ${palabras}\n` : '';
      const promptDefault = `You are a professional online course instructor. Write a spoken script for a short educational video about the topic below.\n\nRules:\n- The script must be entirely in ${langName}.\n- Language level: ${nivel} — adjust vocabulary, sentence complexity, and grammar accordingly.\n- Natural for text-to-speech: no markdown, no emojis, no bullet points, no section headers.\n- Target length: 150–220 words (approximately 1–2 minutes when spoken).\n${palabrasLine}- Write ONLY the spoken text, nothing else.\n\nTopic: ${tema}`;
      const promptGuion = promptPersonalizado || promptDefault;

      const respGuion = await require('axios').post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4o',
          messages: [{ role: 'user', content: promptGuion }],
          temperature: 0.8,
          max_tokens: 800,
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const guionBorrador = respGuion.data.choices[0].message.content.trim();
      emit('guion_listo', { numero, guion: guionBorrador });
      console.log(`[${ts()}] Curso: borrador generado (${guionBorrador.length} chars)`);

      // ── PASO 2b: Humanización del guion ──────────────────────────────────
      emit('progreso', { paso: 2, mensaje: 'Humanizando y ajustando guion para audio...' });

      const HUMANIZACION_DEFAULT = `You are a voice-over script editor specialized in text-to-speech optimization. Revise the following script to make it sound more natural and fluid when read aloud.

Rules:
- Keep the exact same language ({idioma_code}), topic, and language level as the original.
- Replace formal or rigid sentence structures with natural spoken patterns.
- Add smooth transitions and connective phrases between ideas.
- Vary sentence length to create a natural spoken rhythm.
- Avoid lists, colons, semicolons, academic phrasing, and abrupt topic shifts.
- Do NOT add new content, change the meaning, or alter the target language.
- Output ONLY the revised script text, nothing else.

Script to revise:
{guion}`;

      const promptHumanizacionFinal = (promptHumanizacion || HUMANIZACION_DEFAULT)
        .replace(/\{guion\}/g, guionBorrador)
        .replace(/\{idioma_code\}/g, idioma);

      const respHuman = await require('axios').post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4o',
          messages: [{ role: 'user', content: promptHumanizacionFinal }],
          temperature: 0.6,
          max_tokens: 900,
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const guion = respHuman.data.choices[0].message.content.trim();
      fs.writeFileSync(rutaTxt, guion, 'utf-8');
      emit('revision_lista', { numero, guion, rutaTxt: `/output/curso/audio${numero}.txt` });
      console.log(`[${ts()}] Curso: guion humanizado guardado en ${rutaTxt}`);

      // ── PASO 3: Audio con Google TTS ──────────────────────────────────────
      emit('progreso', { paso: 3, mensaje: `Sintetizando audio ${idioma} (${genero})...` });

      const { GoogleAuth } = require('google-auth-library');
      const auth = new GoogleAuth({
        keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
      const googleClient = await auth.getClient();
      const { token } = await googleClient.getAccessToken();

      const vocesIdioma = CURSO_VOCES_GOOGLE[idioma];
      const nombreVoz   = vocesIdioma[genero];
      const langCode    = CURSO_LANG_CODE[idioma];
      const textoTts    = Buffer.byteLength(guion, 'utf8') > 4800 ? guion.slice(0, 4800) : guion;

      const respTts = await require('axios').post(
        'https://texttospeech.googleapis.com/v1/text:synthesize',
        {
          input: { text: textoTts },
          voice: { languageCode: langCode, name: nombreVoz },
          audioConfig: { audioEncoding: 'MP3' },
        },
        {
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        }
      );

      const buffer = Buffer.from(respTts.data.audioContent, 'base64');
      fs.writeFileSync(rutaMp3, buffer);
      emit('audio_listo', { numero, rutaMp3: `/output/curso/audio${numero}.mp3`, nombreVoz, langCode });
      console.log(`[${ts()}] Curso: audio guardado en ${rutaMp3}`);

      // ── PASO 4 (opcional): Imágenes + Video ───────────────────────────────
      let rutaVideoCurso = null;
      if (modo === 'video') {
        // — Imágenes —
        emit('progreso', { paso: 4, mensaje: `Generando ${cantidadImagenes} imagen(es) con ${apiImagen}...` });
        console.log(`[${ts()}] Curso: iniciando imágenes api=${apiImagen} modelo=${modeloImagen} cantidad=${cantidadImagenes}`);

        const promptImagen = `Professional educational illustration for an online course video about: ${tema}. Language level ${nivel}. Clean, informative, no text overlays, suitable for e-learning.`;

        let rutasOrdenadas;
        try {
          rutasOrdenadas = await generarImagenesDirectas(
            promptImagen, cantidadImagenes, id, modeloImagen, apiImagen,
            async (n, _ruta) => {
              emit('imagen_lista', { n, total: cantidadImagenes });
              console.log(`[${ts()}] Curso: imagen ${n}/${cantidadImagenes} lista.`);
            },
            null, 'medium'
          );
        } catch (errImg) {
          throw new Error(`Error en imágenes: ${errImg.message}`);
        }

        if (!rutasOrdenadas || rutasOrdenadas.length === 0) {
          throw new Error('generarImagenesDirectas devolvió un array vacío.');
        }
        console.log(`[${ts()}] Curso: ${rutasOrdenadas.length} imágenes listas. Iniciando FFmpeg...`);

        // — Video —
        emit('progreso', { paso: 5, mensaje: 'Renderizando video con FFmpeg...' });
        rutaVideoCurso = path.join(DIR_CURSO, `video${numero}.mp4`);
        try {
          await generarVideo(rutaMp3, rutasOrdenadas, rutaVideoCurso, null);
        } catch (errVid) {
          throw new Error(`Error FFmpeg: ${errVid.message}`);
        }

        emit('video_listo', { numero, video: `/output/curso/video${numero}.mp4` });
        console.log(`[${ts()}] Curso: video guardado en ${rutaVideoCurso}`);
      }

      // ── PASO YouTube (opcional) ───────────────────────────────────────────
      let youtubeResult = null;
      if (subirYoutube && rutaVideoCurso) {
        try {
          emit('progreso', { paso: 6, mensaje: 'Generando título y descripción para YouTube...' });
          const meta = await yt.generarMetadatosYoutube(tema, guion, idioma, nivel);
          emit('youtube_metadatos', { titulo: meta.titulo, descripcion: meta.descripcion, tags: meta.tags });
          console.log(`[${ts()}] YouTube: metadatos listos → "${meta.titulo}"`);

          emit('youtube_subiendo', {});
          console.log(`[${ts()}] YouTube: subiendo video al canal "${canalYoutube}"...`);
          youtubeResult = await yt.subirVideo({
            rutaVideo:   rutaVideoCurso,
            titulo:      meta.titulo,
            descripcion: meta.descripcion,
            tags:        meta.tags,
            canal:       canalYoutube,
            privacidad:  privacidadYoutube,
          });
          emit('youtube_listo', { url: youtubeResult.url, videoId: youtubeResult.videoId });
          console.log(`[${ts()}] YouTube: video publicado → ${youtubeResult.url}`);
        } catch (errYT) {
          console.error(`[curso/generar] YouTube ERROR:`, errYT.message);
          emit('youtube_error', { mensaje: errYT.message });
          // Error no fatal: el video ya está generado localmente
        }
      }

      // ── FINALIZADO ────────────────────────────────────────────────────────
      emit('finalizado', {
        numero,
        guion,
        mp3:   `/output/curso/audio${numero}.mp3`,
        txt:   `/output/curso/audio${numero}.txt`,
        ...(rutaVideoCurso  ? { video: `/output/curso/video${numero}.mp4` } : {}),
        ...(youtubeResult   ? { youtubeUrl: youtubeResult.url }            : {}),
      });
      console.log(`[${ts()}] Curso: audio${numero} completado (${idioma}, modo=${modo}).`);

    } catch (err) {
      const mensaje = err?.response?.data ? JSON.stringify(err.response.data) : (err?.message || String(err));
      console.error(`[curso/generar] ERROR:`, mensaje);
      console.error(err?.stack || err);
      emit('pipeline_error', { mensaje });
    }
  })();
});

// ── GET /youtube/canales ───────────────────────────────────────────────────────
app.get('/youtube/canales', (req, res) => {
  if (!process.env.YOUTUBE_CLIENT_ID || !process.env.YOUTUBE_CLIENT_SECRET) {
    return res.status(503).json({ error: 'YouTube no configurado. Agrega YOUTUBE_CLIENT_ID y YOUTUBE_CLIENT_SECRET al .env' });
  }
  res.json(yt.listarCanalesConfig());
});

// ── GET /youtube/auth — Inicia el flujo OAuth para un canal ───────────────────
app.get('/youtube/auth', (req, res) => {
  if (!process.env.YOUTUBE_CLIENT_ID || !process.env.YOUTUBE_CLIENT_SECRET) {
    return res.status(503).send('YouTube no configurado en .env');
  }
  const canales = yt.listarCanalesConfig();
  const canal   = canales.find(c => c.nombre === req.query.canal);
  if (!canal) {
    return res.status(400).send(`Canal "${req.query.canal}" no encontrado en youtube-channels.json.`);
  }
  res.redirect(yt.obtenerUrlAuth(canal.nombre));
});

// ── GET /youtube/callback — Recibe el código OAuth de Google ──────────────────
app.get('/youtube/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send('Parámetros faltantes en el callback de OAuth.');
  try {
    await yt.manejarCallback(code, state);
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:system-ui,sans-serif;padding:40px;background:#0d0d0f;color:#e2e8f0;">
  <h2 style="color:#22c55e;">&#10003; Canal "${state}" autorizado correctamente</h2>
  <p style="color:#94a3b8;margin-top:12px;">Ya puedes cerrar esta pestaña y volver a
    <a href="/videos_curso.html" style="color:#818cf8;">Videos Curso</a>.
  </p>
</body></html>`);
  } catch (err) {
    res.status(500).send(`Error al procesar el callback: ${err.message}`);
  }
});

// ── Middleware de errores global ──────────────────────────────────────────────
// En producción (NODE_ENV=production) se devuelve un mensaje genérico para
// evitar filtrar rutas internas, tokens o stack traces al cliente.
app.use((err, req, res, _next) => {
  console.error('[ERROR GLOBAL]', err.message);
  res.status(err.status || 500).json({ error: seg.mensajeError(err) });
});

// ── Arranque ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n[servidor] Corriendo en http://localhost:${PORT}`);
});
