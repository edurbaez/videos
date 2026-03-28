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

// Voces Google TTS disponibles por genero
const VOCES_GOOGLE = {
  masculino: 'es-US-Neural2-B',
  femenino:  'es-US-Neural2-A',
};

// Voces OpenAI TTS disponibles por genero
const VOCES_OPENAI = {
  masculino: 'onyx',
  femenino:  'nova',
};

async function generarAudioGoogle(texto, rutaDestino, genero) {
  const ts = () => new Date().toTimeString().slice(0, 8);
  const nombreVoz = VOCES_GOOGLE[genero] || VOCES_GOOGLE.masculino;
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

async function generarAudioOpenAI(texto, rutaDestino, genero) {
  const ts = () => new Date().toTimeString().slice(0, 8);
  const voz = VOCES_OPENAI[genero] || VOCES_OPENAI.masculino;
  console.log(`[${ts()}] Audio: sintetizando con OpenAI TTS — voz: ${voz} (${texto.length} chars)...`);

  let resp;
  try {
    resp = await axios.post(
      'https://api.openai.com/v1/audio/speech',
      {
        model: 'tts-1',
        input: texto,
        voice: voz,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        responseType: 'arraybuffer',
      }
    );
  } catch (err) {
    const detalle = err.response?.data
      ? Buffer.from(err.response.data).toString('utf8')
      : err.message;
    console.error(`[Audio] OpenAI TTS error HTTP ${err.response?.status}:`, detalle);
    throw new Error(`OpenAI TTS HTTP ${err.response?.status}: ${detalle}`);
  }

  fs.writeFileSync(rutaDestino, Buffer.from(resp.data));

  console.log(`[${ts()}] Audio: MP3 guardado en ${rutaDestino}`);
  return rutaDestino;
}

/**
 * Genera un archivo MP3 a partir de texto.
 *
 * @param {string} texto        - Texto a convertir en audio
 * @param {string} rutaDestino  - Ruta absoluta donde guardar el MP3
 * @param {string} [genero]     - 'masculino' | 'femenino' (default: 'masculino')
 * @param {string} [tts]        - 'google' | 'openai' (default: 'google')
 * @returns {string} - Ruta del archivo de audio guardado
 */
async function generarAudio(texto, rutaDestino, genero = 'masculino', tts = 'google') {
  if (tts === 'openai') {
    return generarAudioOpenAI(texto, rutaDestino, genero);
  }
  return generarAudioGoogle(texto, rutaDestino, genero);
}

module.exports = { generarAudio };
