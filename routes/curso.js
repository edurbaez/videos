const express = require('express');
const { v4: uuidv4 } = require('uuid');
const seg = require('../middleware/seguridad');
const { crearCanal } = require('../lib/sse');
const { resolverOpcionesYoutube } = require('../lib/opcionesYoutube');
const { IDIOMAS_CURSO, IDIOMA_CURSO_DEFAULT, NIVELES, NIVEL_DEFAULT } = require('../utils/constantes');
const pipelineCurso = require('../pipelines/curso');

const router = express.Router();
const canal = crearCanal('curso');

const textoOpcional = (valor, max) => (valor ? String(valor).trim().slice(0, max) : null);

router.get('/curso/archivos', (req, res) => res.json(pipelineCurso.listarArchivos()));

router.get('/curso/progreso/:id', canal.ruta);

router.post('/curso/generar', seg.limitarGenerar, (req, res) => {
  const modo = req.body.modo === 'video' ? 'video' : 'audio';
  const apiImagen = ['openai', 'google'].includes(req.body.apiImagen) ? req.body.apiImagen : 'openai';
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
    id: 'curso-' + uuidv4(),
    tema,
    idioma:   IDIOMAS_CURSO.includes(req.body.idioma) ? req.body.idioma : IDIOMA_CURSO_DEFAULT,
    genero:   req.body.genero === 'femenino' ? 'femenino' : 'masculino',
    nivel:    NIVELES.includes(req.body.nivel) ? req.body.nivel : NIVEL_DEFAULT,
    palabras: textoOpcional(req.body.palabras, 300) || '',
    modo,
    cantidadImagenes: seg.validarCantidad(req.body.cantidadImagenes ?? 3, 5),
    apiImagen,
    modeloImagen: apiImagen === 'google'
      ? seg.MODELO_IMAGEN_GOOGLE_DEFAULT
      : (seg.MODELOS_OPENAI.has(modeloPedido) ? modeloPedido : seg.MODELO_IMAGEN_OPENAI_ECONOMICO),
    promptPersonalizado: textoOpcional(req.body.promptPersonalizado, 3000),
    promptHumanizacion:  textoOpcional(req.body.promptHumanizacion, 3000),
    youtube,
  };

  res.json({ id: params.id });
  pipelineCurso.ejecutar(params, canal.emisor(params.id)).catch(() => {});
});

module.exports = router;
