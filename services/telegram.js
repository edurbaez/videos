const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const { ts } = require('../utils/log');

const TIMEOUT_SUBIDA_MS = 180_000;

const MAX_CAPTION_VIDEO = 1024;

/**
 * Envía el video con su caption a Telegram. El caption va una sola vez: como pie del video,
 * salvo que supere el límite de Telegram (1024), en cuyo caso se envía antes como mensaje
 * de texto (hasta 4096) y el video va sin pie.
 *
 * @param {string} rutaVideo - Ruta absoluta del archivo MP4
 * @param {string} caption   - Texto del caption del video
 * @returns {boolean} - true si los envíos fueron exitosos
 */
async function enviarATelegram(rutaVideo, caption = '') {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const base = `https://api.telegram.org/bot${token}`;
  const captionLargo = caption.length > MAX_CAPTION_VIDEO;

  if (captionLargo) {
    console.log(`[${ts()}] Telegram: caption de ${caption.length} caracteres, se envía como texto...`);
    await enviarTexto(caption);
  }

  console.log(`[${ts()}] Telegram: enviando video (${rutaVideo})...`);
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('video', fs.createReadStream(rutaVideo));
  if (caption && !captionLargo) form.append('caption', caption);
  form.append('supports_streaming', 'true');

  await axios.post(`${base}/sendVideo`, form, {
    headers: form.getHeaders(),
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: TIMEOUT_SUBIDA_MS,
  });

  console.log(`[${ts()}] Telegram: video enviado correctamente.`);
  return true;
}

/**
 * Envía un mensaje de texto plano a Telegram.
 * @param {string} texto
 */
async function enviarTexto(texto) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  console.log(`[${ts()}] Telegram: enviando texto... (chat_id=${chatId})`);
  // Telegram permite máx 4096 caracteres por mensaje
  const textoTruncado = texto.length > 4096 ? texto.slice(0, 4090) + '...' : texto;

  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: textoTruncado,
    });
  } catch (err) {
    const status = err.response?.status;
    const detalle = err.response?.data ? JSON.stringify(err.response.data) : (err.message || err.code || String(err));
    console.error(`[Telegram] Error sendMessage HTTP ${status} | code: ${err.code} | msg: ${err.message}`);
    throw new Error(`Telegram sendMessage ${status || err.code}: ${detalle}`);
  }
  console.log(`[${ts()}] Telegram: texto enviado.`);
}

/**
 * Envía una sola foto a Telegram.
 * @param {string} ruta - Ruta absoluta de la imagen
 */
async function enviarFoto(ruta) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('photo', fs.createReadStream(ruta));
  console.log(`[${ts()}] Telegram: enviando foto ${ruta}...`);
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendPhoto`, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: TIMEOUT_SUBIDA_MS,
    });
    console.log(`[${ts()}] Telegram: foto enviada.`);
  } catch (err) {
    const detalle = err.response?.data ? JSON.stringify(err.response.data) : (err.message || err.code);
    console.error(`[Telegram] Error sendPhoto HTTP ${err.response?.status}:`, detalle);
    throw new Error(`Telegram sendPhoto: ${detalle}`);
  }
}

/**
 * Envía un archivo de audio MP3 a Telegram.
 * @param {string} ruta - Ruta absoluta del archivo MP3
 * @param {string} [caption] - Texto opcional al pie del audio
 */
async function enviarAudio(ruta, caption = '') {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('audio', fs.createReadStream(ruta));
  if (caption) form.append('caption', caption.slice(0, 1024));
  console.log(`[${ts()}] Telegram: enviando audio ${ruta}...`);
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendAudio`, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: TIMEOUT_SUBIDA_MS,
    });
    console.log(`[${ts()}] Telegram: audio enviado.`);
  } catch (err) {
    const detalle = err.response?.data ? JSON.stringify(err.response.data) : (err.message || err.code);
    console.error(`[Telegram] Error sendAudio HTTP ${err.response?.status}:`, detalle);
    throw new Error(`Telegram sendAudio: ${detalle}`);
  }
}

module.exports = { enviarATelegram, enviarTexto, enviarFoto, enviarAudio };
