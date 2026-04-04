const axios = require('axios');
require('dotenv').config();

const { renderPrompt, joinHashtags } = require('../utils/prompts');

/**
 * Genera un caption para el Short de YouTube basándose en el guion y el nicho.
 *
 * @param {string} guion       - Texto del guion mejorado
 * @param {object} nichoConfig - Objeto retornado por cargarNicho()
 * @returns {string} - Caption listo para copiar y pegar
 */
async function generarCaption(guion, nichoConfig) {
  const ts = () => new Date().toTimeString().slice(0, 8);
  console.log(`[${ts()}] Caption: generando con GPT-4o-mini (nicho: ${nichoConfig.id})...`);

  const prompt = renderPrompt(nichoConfig.prompts.caption, {
    guion,
    nombre_nicho:   nichoConfig.nombre,
    caption_estilo: nichoConfig.caption.estilo,
    cta:            nichoConfig.caption.ctaDefault,
    hashtags_base:  joinHashtags(nichoConfig.caption.hashtagsBase),
  });

  const resp = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const caption = resp.data.choices[0].message.content.trim();
  console.log(`[${ts()}] Caption: generado correctamente.`);
  return caption;
}

module.exports = { generarCaption };
