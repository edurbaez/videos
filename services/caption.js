const { chat } = require('./openai');
const { ts } = require('../utils/log');
const { renderPrompt, joinHashtags } = require('../utils/prompts');

/**
 * Genera un caption para el Short de YouTube basándose en el guion y el nicho.
 *
 * @param {string} guion       - Texto del guion mejorado
 * @param {object} nichoConfig - Objeto retornado por cargarNicho()
 * @returns {string} - Caption listo para copiar y pegar
 */
async function generarCaption(guion, nichoConfig) {
  console.log(`[${ts()}] Caption: generando con GPT-4o-mini (nicho: ${nichoConfig.id})...`);

  const prompt = renderPrompt(nichoConfig.prompts.caption, {
    guion,
    nombre_nicho:   nichoConfig.nombre,
    idioma:         nichoConfig.idioma,
    caption_estilo: nichoConfig.caption.estilo,
    cta:            nichoConfig.caption.ctaDefault,
    hashtags_base:  joinHashtags(nichoConfig.caption.hashtagsBase),
  });

  const caption = await chat({ model: 'gpt-4o-mini', prompt, temperature: 0.7 });
  console.log(`[${ts()}] Caption: generado correctamente.`);
  return caption;
}

module.exports = { generarCaption };
