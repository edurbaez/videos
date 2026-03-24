const axios = require('axios');
const fs = require('fs');
const { GoogleAuth } = require('google-auth-library');
require('dotenv').config();

async function obtenerTokenTTS() {
  const auth = new GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  return token;
}

// Voces disponibles por genero
const VOCES = {
  masculino: 'es-US-Neural2-B',
  femenino:  'es-US-Neural2-A',
};

/**
 * Genera un archivo MP3 a partir de texto usando Google Cloud Text-to-Speech.
 *
 * @param {string} texto        - Texto a convertir en audio
 * @param {string} rutaDestino  - Ruta absoluta donde guardar el MP3
 * @param {string} [genero]     - 'masculino' | 'femenino' (default: 'masculino')
 * @returns {string} - Ruta del archivo de audio guardado
 */
async function generarAudio(texto, rutaDestino, genero = 'masculino') {
  const ts = () => new Date().toTimeString().slice(0, 8);
  const nombreVoz = VOCES[genero] || VOCES.masculino;
  console.log(`[${ts()}] Audio: sintetizando con Google TTS — voz: ${nombreVoz} (${texto.length} chars)...`);

  // Google TTS permite máx 5000 bytes por petición
  const textoTruncado = Buffer.byteLength(texto, 'utf8') > 4800
    ? texto.slice(0, 4800)
    : texto;

  const token = await obtenerTokenTTS();

  let resp;
  try {
    resp = await axios.post(
      'https://texttospeech.googleapis.com/v1/text:synthesize',
      {
        input: { text: textoTruncado },
        voice: { languageCode: 'es-US', name: nombreVoz },
        audioConfig: { audioEncoding: 'MP3' },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err) {
    const detalle = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`[Audio] Google TTS error HTTP ${err.response?.status}:`, detalle);
    throw new Error(`Google TTS HTTP ${err.response?.status}: ${detalle}`);
  }

  const buffer = Buffer.from(resp.data.audioContent, 'base64');
  fs.writeFileSync(rutaDestino, buffer);

  console.log(`[${ts()}] Audio: MP3 guardado en ${rutaDestino}`);
  return rutaDestino;
}

module.exports = { generarAudio };
