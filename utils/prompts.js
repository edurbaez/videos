const fs = require('fs');
const path = require('path');

const DIR_PROMPTS = path.join(__dirname, '..', 'prompts');
const RE_NOMBRE = /^[a-z0-9_-]+$/i;
const RE_ARCHIVO = /^[a-z0-9_-]+\.txt$/i;

/**
 * Reemplaza todos los {{placeholder}} de un template con los valores del objeto vars.
 * Los placeholders sin valor en vars se dejan como cadena vacía.
 *
 * @param {string} template - Texto con {{placeholders}}
 * @param {Object} vars     - Mapa de { placeholder: valor }
 * @returns {string}
 */
function renderPrompt(template, vars = {}) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const valor = vars[key];
    if (valor === undefined || valor === null) return '';
    return String(valor);
  });
}

/**
 * Convierte un array de hashtags a string listo para usar en un prompt.
 * Ejemplo: ['#motivacion', '#exito'] → '#motivacion #exito'
 *
 * @param {string[]} hashtags
 * @returns {string}
 */
function joinHashtags(hashtags = []) {
  return hashtags.join(' ');
}

/**
 * Reads prompts/<carpeta>/<archivo>. Both names are validated (no separators, no "..")
 * and the resolved path must stay inside prompts/, so a caller can never read arbitrary files.
 */
function leerPromptArchivo(carpeta, archivo, base = DIR_PROMPTS) {
  if (typeof carpeta !== 'string' || !RE_NOMBRE.test(carpeta) || typeof archivo !== 'string' || !RE_ARCHIVO.test(archivo)) {
    throw new Error(`Prompt inválido: "${carpeta}/${archivo}".`);
  }
  const raiz = path.resolve(base);
  const ruta = path.resolve(raiz, carpeta, archivo);
  if (!ruta.startsWith(raiz + path.sep)) throw new Error(`Prompt inválido: "${carpeta}/${archivo}".`);
  return fs.readFileSync(ruta, 'utf-8');
}

module.exports = { renderPrompt, joinHashtags, leerPromptArchivo };
