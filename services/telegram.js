const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
require('dotenv').config();

/**
 * Envía el caption y el video a un canal/chat de Telegram en dos pasos:
 *  1. Mensaje de texto con el caption
 *  2. Video como archivo multimedia (con soporte de streaming)
 *
 * @param {string} rutaVideo - Ruta absoluta del archivo MP4
 * @param {string} caption   - Texto del caption del video
 * @returns {boolean} - true si ambos envíos fueron exitosos
 */
async function enviarATelegram(rutaVideo, caption) {
  const ts = () => new Date().toTimeString().slice(0, 8);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const base = `https://api.telegram.org/bot${token}`;

  // ── PASO 1: Enviar caption como texto ────────────────────────────────────
  console.log(`[${ts()}] Telegram: enviando caption...`);
  await axios.post(`${base}/sendMessage`, {
    chat_id: chatId,
    text: caption,
  });
  console.log(`[${ts()}] Telegram: caption enviado.`);

  // ── PASO 2: Enviar video ──────────────────────────────────────────────────
  console.log(`[${ts()}] Telegram: enviando video (${rutaVideo})...`);
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('video', fs.createReadStream(rutaVideo));
  form.append('caption', caption);
  form.append('supports_streaming', 'true');

  await axios.post(`${base}/sendVideo`, form, {
    headers: form.getHeaders(),
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  console.log(`[${ts()}] Telegram: video enviado correctamente.`);
  return true;
}

/**
 * Envía un mensaje de texto plano a Telegram.
 * @param {string} texto
 */
async function enviarTexto(texto) {
  const ts = () => new Date().toTimeString().slice(0, 8);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  console.log(`[${ts()}] Telegram: enviando texto... (chat_id=${chatId}, token=${token?.slice(0,10)}...)`);
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
 * Envía un grupo de fotos a Telegram (máx 10 por grupo).
 * @param {string[]} rutasImagenes - Rutas absolutas de las imágenes
 */
async function enviarFotos(rutasImagenes) {
  const ts = () => new Date().toTimeString().slice(0, 8);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const base = `https://api.telegram.org/bot${token}`;

  // Telegram permite máx 10 por grupo; dividir si hay más
  const grupos = [];
  for (let i = 0; i < rutasImagenes.length; i += 10) {
    grupos.push(rutasImagenes.slice(i, i + 10));
  }

  for (const grupo of grupos) {
    const form = new FormData();
    form.append('chat_id', chatId);
    const media = grupo.map((ruta, i) => {
      const campo = `foto${i}`;
      form.append(campo, fs.createReadStream(ruta));
      return { type: 'photo', media: `attach://${campo}` };
    });
    form.append('media', JSON.stringify(media));
    console.log(`[${ts()}] Telegram: enviando ${grupo.length} foto(s)...`);
    await axios.post(`${base}/sendMediaGroup`, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    console.log(`[${ts()}] Telegram: fotos enviadas.`);
  }
}

/**
 * Envía una sola foto a Telegram.
 * @param {string} ruta - Ruta absoluta de la imagen
 */
async function enviarFoto(ruta) {
  const ts = () => new Date().toTimeString().slice(0, 8);
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
  const ts = () => new Date().toTimeString().slice(0, 8);
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
    });
    console.log(`[${ts()}] Telegram: audio enviado.`);
  } catch (err) {
    const detalle = err.response?.data ? JSON.stringify(err.response.data) : (err.message || err.code);
    console.error(`[Telegram] Error sendAudio HTTP ${err.response?.status}:`, detalle);
    throw new Error(`Telegram sendAudio: ${detalle}`);
  }
}

module.exports = { enviarATelegram, enviarTexto, enviarFotos, enviarFoto, enviarAudio };
