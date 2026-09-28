const {
  MODELOS_OPENAI,
  MODELO_IMAGEN_OPENAI_DEFAULT,
  MODELO_IMAGEN_OPENAI_ECONOMICO,
  MODELO_IMAGEN_GOOGLE_DEFAULT,
} = require('../middleware/seguridad');

const LANG_NAMES = {
  de: 'German (Deutsch)', en: 'English', es: 'Spanish (Español)',
  fr: 'French (Français)', pt: 'Portuguese (Português)',
};

const IDIOMAS_CURSO = Object.keys(LANG_NAMES);
const IDIOMA_CURSO_DEFAULT = 'de';

const NIVELES = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const NIVEL_DEFAULT = 'B1';

// Minimum spacing between image API requests (per-minute quotas); shared by shorts, course and long videos
const segEntreImagenes = parseFloat(process.env.LARGO_SEGUNDOS_ENTRE_IMAGENES);
const MS_ENTRE_IMAGENES = (isNaN(segEntreImagenes) ? 10 : Math.min(60, Math.max(0, segEntreImagenes))) * 1000;

module.exports = {
  MS_ENTRE_IMAGENES,
  LANG_NAMES,
  IDIOMAS_CURSO,
  IDIOMA_CURSO_DEFAULT,
  NIVELES,
  NIVEL_DEFAULT,
  // Image model lists live in middleware/seguridad.js (single source of truth)
  MODELOS_OPENAI,
  MODELO_IMAGEN_OPENAI_DEFAULT,
  MODELO_IMAGEN_OPENAI_ECONOMICO,
  MODELO_IMAGEN_GOOGLE_DEFAULT,
};
