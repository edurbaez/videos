const axios = require('axios');
require('dotenv').config();

/**
 * Genera un caption corto con dos hashtags para el Short de YouTube,
 * basándose en el guion final del video.
 *
 * @param {string} guion - Texto del guion mejorado
 * @returns {string} - Caption listo para copiar y pegar
 */
async function generarCaption(guion) {
  const ts = () => new Date().toTimeString().slice(0, 8);
  console.log(`[${ts()}] Caption: generando con GPT-4o-mini...`);

  const resp = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content:
            'Actúa como un experto en copy para YouTube Shorts. En función del texto que se te ' +
            'pasa, escribe un copy breve y dos hashtags para un short de YouTube. Devuelve el ' +
            `texto listo para copiar y pegar, sin comentarios ni aclaratorias. Texto: ${guion}`,
        },
      ],
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
