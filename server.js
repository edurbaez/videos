require('dotenv').config();

const express = require('express');
const cors = require('cors');
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

// ── Inicialización ────────────────────────────────────────────────────────────
crearCarpetas();

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

      // ── PASO 2: Caption + (Audio → Subtítulos) + Imágenes en paralelo ──────
      console.log(`[${ts()}] Pipeline: paso 2 — caption, audio+subtítulos, imágenes en paralelo`);
      const [caption, rutaSRT, rutasImagenes] = await Promise.all([

        // Caption
        generarCaption(guion_final, nichoConfig).then(c => {
          emitirEvento(id, 'caption_listo', { caption: c });
          return c;
        }),

        // Audio → (Subtítulos si están activados)
        generarAudio(guion_audio, rutaAudio(id), vozFinal, ttsFinal, nichoConfig.idioma).then(async () => {
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
        generarImagenes(guion_final, parseInt(cantidad), id, (n, prompt) => {
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

      // ── PASO 5: Historial ────────────────────────────────────────────────
      const cantidadNum = parseInt(cantidad);
      guardarEntrada({
        id,
        tema,
        nicho,
        nombreNicho: nichoConfig.nombre,
        caption,
        guion: guion_final,
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
        guion: guion_final,
        caption,
        audio: `/output/audios/audio-${id}.mp3`,
        imagenes: Array.from({ length: cantidadNum }, (_, i) => `/output/imagenes/imagen-${id}-${i + 1}.png`),
        video: `/output/videos/video-${id}.mp4`,
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
