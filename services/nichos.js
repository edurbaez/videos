const fs = require('fs');
const path = require('path');

const RUTA_NICHOS = path.join(__dirname, '..', 'nichos');

const PROMPTS_ARCHIVOS = {
  guionBorrador: 'prompt-guion-borrador.txt',
  guionMejora:   'prompt-guion-mejora.txt',
  caption:       'prompt-caption.txt',
  imagenes:      'prompt-imagenes.txt',
  storyboard:    'prompt-storyboard.txt',
};

/**
 * Devuelve un array con los nichos disponibles (id + nombre + descripcion + defaults).
 * Solo incluye carpetas que tengan un config.json válido.
 * @returns {{ id: string, nombre: string, descripcion: string, defaults: object }[]}
 */
function listarNichos() {
  if (!fs.existsSync(RUTA_NICHOS)) return [];

  return fs.readdirSync(RUTA_NICHOS, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      const rutaConfig = path.join(RUTA_NICHOS, d.name, 'config.json');
      if (!fs.existsSync(rutaConfig)) return null;
      try {
        const config = JSON.parse(fs.readFileSync(rutaConfig, 'utf-8'));
        return {
          id:          config.id          || d.name,
          nombre:      config.nombre      || d.name,
          descripcion: config.descripcion || '',
          defaults:    config.defaults    || {},
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Carga un nicho completo por su id: config + todos los prompts.
 * Lanza un error si el nicho no existe o el config.json es inválido.
 *
 * @param {string} id - Identificador del nicho (nombre de la carpeta)
 * @returns {object} Objeto nicho con config y prompts listos para usar
 */
function cargarNicho(id) {
  // Validar formato: solo letras, números, guiones y guiones bajos.
  // Bloquea path traversal como "../../../etc/passwd" antes de tocar el FS.
  if (!id || typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Nicho "${id}" inválido.`);
  }

  const rutaNicho = path.join(RUTA_NICHOS, id);

  // Segunda capa: el path resuelto debe estar dentro de RUTA_NICHOS.
  // Evita bypasses con unicode o combinaciones de separadores.
  if (!path.resolve(rutaNicho).startsWith(path.resolve(RUTA_NICHOS) + path.sep)) {
    throw new Error(`Nicho "${id}" inválido.`);
  }

  if (!fs.existsSync(rutaNicho)) {
    throw new Error(`Nicho "${id}" no encontrado. Nichos disponibles: ${listarNichos().map(n => n.id).join(', ')}`);
  }

  const rutaConfig = path.join(rutaNicho, 'config.json');
  if (!fs.existsSync(rutaConfig)) {
    throw new Error(`Nicho "${id}" no tiene config.json.`);
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(rutaConfig, 'utf-8'));
  } catch (e) {
    throw new Error(`config.json del nicho "${id}" es inválido: ${e.message}`);
  }

  // Cargar prompts — si un archivo no existe, el campo queda como null
  const prompts = {};
  for (const [clave, archivo] of Object.entries(PROMPTS_ARCHIVOS)) {
    const rutaPrompt = path.join(rutaNicho, archivo);
    prompts[clave] = fs.existsSync(rutaPrompt)
      ? fs.readFileSync(rutaPrompt, 'utf-8')
      : null;
  }

  return {
    id:          config.id          || id,
    nombre:      config.nombre      || id,
    descripcion: config.descripcion || '',
    idioma:      config.idioma      || 'es',
    defaults:    config.defaults    || {},
    guion:       config.guion       || {},
    caption:     config.caption     || {},
    imagenes:    config.imagenes    || {},
    prompts,
  };
}

module.exports = { listarNichos, cargarNicho };
