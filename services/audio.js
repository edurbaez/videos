const axios = require('axios');
const fs = require('fs');
const { obtenerAccessToken } = require('./googleAuth');
const { ts } = require('../utils/log');
const { LANG_NAMES } = require('../utils/constantes');

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

// Perfil 'hd' (videos largos y cursos). Chirp 3 HD ofrece las mismas voces en todos los locales de LANG_CODE_GOOGLE
const VOCES_CHIRP_HD = { masculino: 'Achird', femenino: 'Sulafat' };
const VELOCIDAD_HD = 0.95;

const MODELO_OPENAI_HD = 'gpt-4o-mini-tts';
const VOCES_OPENAI_HD = { masculino: 'cedar', femenino: 'marin' };
const INSTRUCCIONES_OPENAI_HD = {
  profesor: 'You are a warm, patient language teacher recording a lesson. Speak clearly with native pronunciation, at a calm pace slightly slower than conversational speech, with natural intonation and short pauses between sentences so learners can follow.',
  alumno: 'You are a curious, friendly language learner talking with your teacher. Sound natural and engaged, with native pronunciation, speaking clearly at a relaxed pace.',
};

function resolverVozGoogleHd(idioma, genero) {
  const langCode = LANG_CODE_GOOGLE[idioma] || 'es-US';
  return { nombreVoz: `${langCode}-Chirp3-HD-${VOCES_CHIRP_HD[genero] || VOCES_CHIRP_HD.masculino}`, langCode };
}

function resolverVozGoogle(idioma, genero, vozEspecifica) {
  const vocesIdioma = VOCES_GOOGLE[idioma] || VOCES_GOOGLE['es'];
  return {
    nombreVoz: vozEspecifica || vocesIdioma[genero] || vocesIdioma.masculino,
    langCode:  LANG_CODE_GOOGLE[idioma] || 'es-US',
  };
}

/**
 * Recorta a maxBytes UTF-8 sin partir caracteres multibyte, cortando en el último
 * fin de oración si existe. slice() por caracteres no sirve: ä/é ocupan 2 bytes.
 */
function recortarPorBytes(texto, maxBytes) {
  if (Buffer.byteLength(texto, 'utf8') <= maxBytes) return texto;
  let recortado = Buffer.from(texto, 'utf8').subarray(0, maxBytes).toString('utf8').replace(/�+$/, '');
  const finOracion = Math.max(recortado.lastIndexOf('. '), recortado.lastIndexOf('! '), recortado.lastIndexOf('? '));
  if (finOracion > recortado.length * 0.5) recortado = recortado.slice(0, finOracion + 1);
  return recortado;
}

async function generarAudioGoogle(texto, rutaDestino, genero, idioma = 'es', vozEspecifica, opciones = {}) {
  if (opciones.perfil === 'hd' && !vozEspecifica) {
    try {
      const vozHd = resolverVozGoogleHd(idioma, genero).nombreVoz;
      return await generarAudioGoogle(texto, rutaDestino, genero, idioma, vozHd, { velocidad: VELOCIDAD_HD });
    } catch (err) {
      // Only request errors (unsupported voice/locale, rejected text) fall back; quota and 5xx propagate
      if (!/HTTP 4\d\d/.test(err.message) || /HTTP 429/.test(err.message)) throw err;
      console.warn(`[${ts()}] Audio: Chirp 3 HD falló, se usa Neural2: ${err.message.slice(0, 200)}`);
    }
  }
  const { nombreVoz, langCode } = resolverVozGoogle(idioma, genero, vozEspecifica);
  console.log(`[${ts()}] Audio: sintetizando con Google TTS — voz: ${nombreVoz} lang: ${langCode} (${texto.length} chars)...`);

  // Google TTS permite máx 5000 bytes por petición
  const textoTruncado = recortarPorBytes(texto, 4800);
  if (textoTruncado !== texto) {
    console.warn(`[${ts()}] Audio: texto recortado de ${Buffer.byteLength(texto, 'utf8')} a ${Buffer.byteLength(textoTruncado, 'utf8')} bytes (límite Google TTS).`);
  }

  const token = await obtenerAccessToken();

  let resp;
  try {
    resp = await axios.post(
      'https://texttospeech.googleapis.com/v1/text:synthesize',
      {
        input: { text: textoTruncado },
        voice: { languageCode: langCode, name: nombreVoz },
        audioConfig: opciones.velocidad
          ? { audioEncoding: 'MP3', speakingRate: opciones.velocidad }
          : { audioEncoding: 'MP3' },
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

async function generarAudioOpenAI(texto, rutaDestino, genero, vozEspecifica, idioma = 'es', opciones = {}) {
  const hd = opciones.perfil === 'hd';
  const voces = hd ? VOCES_OPENAI_HD : VOCES_OPENAI;
  const voz = vozEspecifica || voces[genero] || voces.masculino;
  const cuerpo = { model: hd ? MODELO_OPENAI_HD : 'tts-1', input: texto, voice: voz };
  if (hd) {
    const base = INSTRUCCIONES_OPENAI_HD[opciones.rol] || INSTRUCCIONES_OPENAI_HD.profesor;
    cuerpo.instructions = LANG_NAMES[idioma] ? `${base} The text is in ${LANG_NAMES[idioma]}.` : base;
  }
  console.log(`[${ts()}] Audio: sintetizando con OpenAI TTS — modelo: ${cuerpo.model} voz: ${voz} (${texto.length} chars)...`);

  let resp;
  try {
    resp = await axios.post(
      'https://api.openai.com/v1/audio/speech',
      cuerpo,
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
 * @param {string} [idioma]
 * @param {string} [vozEspecifica]
 * @param {object} [opciones]   - { perfil: 'hd', rol: 'profesor'|'alumno' }; 'hd' solo en largo/curso (Chirp 3 HD / gpt-4o-mini-tts)
 * @returns {string} - Ruta del archivo de audio guardado
 */
async function generarAudio(texto, rutaDestino, genero = 'masculino', tts = 'google', idioma = 'es', vozEspecifica, opciones = {}) {
  if (tts === 'openai') {
    return generarAudioOpenAI(texto, rutaDestino, genero, vozEspecifica, idioma, opciones);
  }
  return generarAudioGoogle(texto, rutaDestino, genero, idioma, vozEspecifica, opciones);
}

module.exports = { generarAudio, resolverVozGoogle, resolverVozGoogleHd };
