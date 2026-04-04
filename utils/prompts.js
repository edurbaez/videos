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

module.exports = { renderPrompt, joinHashtags };
