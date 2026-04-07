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

// Voces Google TTS disponibles por idioma y genero
const VOCES_GOOGLE = {
  'es': { masculino: 'es-US-Neural2-B', femenino: 'es-US-Neural2-A' },
  'de': { masculino: 'de-DE-Neural2-B', femenino: 'de-DE-Neural2-A' },
  'en': { masculino: 'en-US-Neural2-D', femenino: 'en-US-Neural2-F' },
  'fr': { masculino: 'fr-FR-Neural2-B', femenino: 'fr-FR-Neural2-A' },
  'pt': { masculino: 'pt-BR-Neural2-B', femenino: 'pt-BR-Neural2-A' },
};

const LANG_CODE_GOOGLE = {
  'es': 'es-US',
  'de': 'de-DE',
  'en': 'en-US',
  'fr': 'fr-FR',
  'pt': 'pt-BR',
};

// Voces OpenAI TTS disponibles por genero
const VOCES_OPENAI = {
  masculino: 'onyx',
  femenino:  'nova',
};

async function generarAudioGoogle(texto, rutaDestino, genero, idioma = 'es', vozEspecifica) {
  const ts = () => new Date().toTimeString().slice(0, 8);
  const vocesIdioma = VOCES_GOOGLE[idioma] || VOCES_GOOGLE['es'];
  const nombreVoz   = vozEspecifica || vocesIdioma[genero] || vocesIdioma.masculino;
  const langCode    = LANG_CODE_GOOGLE[idioma] || 'es-US';
  console.log(`[${ts()}] Audio: sintetizando con Google TTS — voz: ${nombreVoz} lang: ${langCode} (${texto.length} chars)...`);

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
        voice: { languageCode: langCode, name: nombreVoz },
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

async function generarAudioOpenAI(texto, rutaDestino, genero, vozEspecifica) {
  const ts = () => new Date().toTimeString().slice(0, 8);
  const voz = vozEspecifica || VOCES_OPENAI[genero] || VOCES_OPENAI.masculino;
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
async function generarAudio(texto, rutaDestino, genero = 'masculino', tts = 'google', idioma = 'es', vozEspecifica) {
  if (tts === 'openai') {
    return generarAudioOpenAI(texto, rutaDestino, genero, vozEspecifica);
  }
  return generarAudioGoogle(texto, rutaDestino, genero, idioma, vozEspecifica);
}

module.exports = { generarAudio };
