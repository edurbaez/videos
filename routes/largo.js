const express = require('express');
const { v4: uuidv4 } = require('uuid');
const seg = require('../middleware/seguridad');
const { crearCanal } = require('../lib/sse');
const { resolverOpcionesYoutube } = require('../lib/opcionesYoutube');
const { IDIOMAS_CURSO, IDIOMA_CURSO_DEFAULT, NIVELES, NIVEL_DEFAULT } = require('../utils/constantes');
const { planificar } = require('../services/guionLargo');
const pipelineLargo = require('../pipelines/largo');

const { LIMITES } = pipelineLargo;
const router = express.Router();
const canal = crearCanal('largo');

const acotar = (n, min, max) => Math.min(max, Math.max(min, n));

router.get('/largo/config', (req, res) => res.json(LIMITES));

router.get('/largo/archivos', (req, res) => res.json(pipelineLargo.listarArchivos()));

router.get('/largo/progreso/:id', canal.ruta);

router.post('/largo/generar', seg.limitarGenerar, (req, res) => {
  const modo = ['guion', 'audio', 'video'].includes(req.body.modo) ? req.body.modo : 'video';
  const minutosNum = parseInt(req.body.minutos);
  const segNum = parseInt(req.body.segundosPorImagen);
  const apiImagen = req.body.apiImagen === 'google' ? 'google' : 'openai';
  const modeloPedido = seg.normalizarModeloImagen(req.body.modeloImagen);

  let youtube;
  try {
    youtube = resolverOpcionesYoutube(req.body, modo);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const tema = seg.sanitizarTema(req.body.tema);
  if (!tema) return res.status(400).json({ error: 'El campo "tema" es obligatorio.' });

  const params = {
    id: 'largo-' + uuidv4(),
    tema,
    idioma:   IDIOMAS_CURSO.includes(req.body.idioma) ? req.body.idioma : IDIOMA_CURSO_DEFAULT,
    nivel:    NIVELES.includes(req.body.nivel) ? req.body.nivel : NIVEL_DEFAULT,
    formato:  req.body.formato === 'dialogo' ? 'dialogo' : 'monologo',
    genero:   req.body.genero === 'femenino' ? 'femenino' : 'masculino',
    tts:      req.body.tts === 'openai' ? 'openai' : 'google',
    modo,
    palabras: req.body.palabras ? String(req.body.palabras).trim().slice(0, 300) : '',
    minutos:  acotar(isNaN(minutosNum) ? 10 : minutosNum, LIMITES.minMinutos, LIMITES.maxMinutos),
    segundosPorImagen: isNaN(segNum) ? LIMITES.segundosPorImagen : acotar(segNum, LIMITES.minSegundosImagen, LIMITES.maxSegundosImagen),
    apiImagen,
    modeloImagen: apiImagen === 'google'
      ? seg.MODELO_IMAGEN_GOOGLE_DEFAULT
      : (seg.MODELOS_OPENAI.has(modeloPedido) ? modeloPedido : seg.MODELO_IMAGEN_OPENAI_ECONOMICO),
    youtube,
  };

  res.json({ id: params.id, minutos: params.minutos, secciones: planificar(params.minutos).numSecciones });
  pipelineLargo.ejecutar(params, canal.emisor(params.id)).catch(() => {});
});

module.exports = router;
