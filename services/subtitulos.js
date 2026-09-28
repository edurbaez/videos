const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
require('dotenv').config();

/**
 * Genera un archivo SRT de subtítulos a partir de un MP3 usando Whisper API.
 *
 * @param {string} rutaAudio    - Ruta absoluta del archivo MP3
 * @param {string} rutaDestino  - Ruta absoluta donde guardar el archivo .srt
 * @param {string} idioma       - Código ISO-639-1 del audio (idioma del nicho)
 * @returns {string} - Ruta del archivo SRT guardado
 */
async function generarSubtitulos(rutaAudio, rutaDestino, idioma = 'es') {
  const ts = () => new Date().toTimeString().slice(0, 8);
  console.log(`[${ts()}] Subtitulos: enviando audio a Whisper API...`);

  const form = new FormData();
  form.append('file', fs.createReadStream(rutaAudio));
  form.append('model', 'whisper-1');
  form.append('language', /^[a-z]{2}$/.test(idioma) ? idioma : 'es');
  form.append('response_format', 'srt');

  const resp = await axios.post(
    'https://api.openai.com/v1/audio/transcriptions',
    form,
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        ...form.getHeaders(),
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 180_000,
    }
  );

  fs.writeFileSync(rutaDestino, resp.data, 'utf-8');
  console.log(`[${ts()}] Subtitulos: SRT guardado en ${rutaDestino}`);
  return rutaDestino;
}

module.exports = { generarSubtitulos };
