const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const seg = require('../middleware/seguridad');
const { crearCanal } = require('../lib/sse');
const { resolverOpcionesYoutube } = require('../lib/opcionesYoutube');
const { DIR_REFERENCIAS } = require('../utils/archivos');
const { ts } = require('../utils/log');
const { leerHistorial } = require('../utils/historial');
const { listarNichos, cargarNicho } = require('../services/nichos');
const { obtenerGaleria } = require('../services/imagenes');
const { enviarATelegram } = require('../services/telegram');
const pipelineShort = require('../pipelines/short');

const RAIZ = path.join(__dirname, '..');
const router = express.Router();
// 'error_pipeline' kept as alias for the current frontend (creacion_de_contenido.html)
const canal = crearCanal('shorts', { aliasError: ['error_pipeline'], log: true });

router.get('/progreso/:id', canal.ruta);

router.post('/continuar/:id', (req, res) => {
  const guion = typeof req.body.guion === 'string' ? req.body.guion.trim().slice(0, 5000) : null;
  if (!guion) return res.status(400).json({ error: 'El campo "guion" es obligatorio.' });
  if (!pipelineShort.confirmarGuion(req.params.id, guion)) {
    return res.status(404).json({ error: 'No hay pipeline en espera para este ID.' });
  }
  res.json({ ok: true });
});

router.post('/generar', seg.limitarGenerar, (req, res) => {
  const { nicho = 'motivacion', genero, api, subtitulos = false, tts, estilo, escenario, editarGuion = false } = req.body;

  const tema = seg.sanitizarTema(req.body.tema);
  if (!tema) return res.status(400).json({ error: 'El campo "tema" es obligatorio.' });

  let params;
  try {
    const quality = seg.validarQuality(req.body.quality);
    const refImagePath = seg.validarRefImagePath(req.body.refImagePath, DIR_REFERENCIAS);
    const youtube = resolverOpcionesYoutube(req.body);
    const nichoConfig = cargarNicho(nicho);
    params = pipelineShort.construirParams({
      id: uuidv4(), tema, nicho, nichoConfig, genero, api, tts, estilo, escenario,
      cantidad: req.body.cantidad, modelo: req.body.modelo,
      quality, subtitulos, editarGuion, refImagePath, youtube,
    });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  console.log(`\n[${ts()}] === NUEVA GENERACIÓN id=${params.id} nicho=${nicho} tema="${tema}" imágenes=${params.cantidad} voz=${params.voz} tts=${params.tts} modelo=${params.modelo} estilo=${params.estilo} escenario=${params.escenario} ===`);

  res.json({ id: params.id });
  pipelineShort.ejecutar(params, canal.emisor(params.id)).catch(() => {});
});

router.get('/nichos', (req, res) => res.json(listarNichos()));
// Shorts only by default (the shorts page and /reenviar expect that shape); ?tipo=curso|largo|todos for the rest
router.get('/historial', (req, res) => {
  const tipo = ['short', 'curso', 'largo', 'todos'].includes(req.query.tipo) ? req.query.tipo : 'short';
  res.json(leerHistorial(tipo === 'todos' ? {} : { tipo }));
});
router.get('/galeria', (req, res) => res.json(obtenerGaleria()));

router.post('/reenviar/:id', seg.limitarGenerar, async (req, res) => {
  const { id } = req.params;
  const entrada = leerHistorial({ tipo: 'short' }).find(e => e.id === id);
  if (!entrada) return res.status(404).json({ error: 'Entrada no encontrada en el historial.' });

  try {
    console.log(`[${ts()}] Reenvío: enviando id=${id} a Telegram...`);
    await enviarATelegram(path.join(RAIZ, entrada.rutas.video.replace(/^\//, '')), entrada.caption);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[${ts()}] Reenvío ERROR [${id}]:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
