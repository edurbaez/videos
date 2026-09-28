const axios = require('axios');

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const TIMEOUT_MS = 120_000;
const REINTENTOS = 3;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 30_000;

const esperar = ms => new Promise(r => setTimeout(r, ms));

function esReintentable(err) {
  const status = err.response?.status;
  // insufficient_quota also comes back as 429 but retrying never helps
  if (err.response?.data?.error?.code === 'insufficient_quota') return false;
  return status === 429 || (status >= 500 && status < 600);
}

function pausaReintento(err, intento) {
  const retryAfter = parseFloat(err.response?.headers?.['retry-after']);
  if (!isNaN(retryAfter)) return Math.min(BACKOFF_MAX_MS, retryAfter * 1000);
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** intento);
  return base / 2 + Math.random() * base / 2;
}

/**
 * Chat Completions call with default timeout and backoff retry on 429/5xx.
 * Returns the trimmed message content; rethrows the original axios error otherwise.
 */
async function chat({ model, prompt, messages, json = false, maxTokens, temperature, timeout = TIMEOUT_MS }) {
  if (!model) throw new Error('openai.chat: falta "model".');
  const body = { model, messages: messages || [{ role: 'user', content: prompt }] };
  if (temperature !== undefined) body.temperature = temperature;
  if (maxTokens !== undefined) body.max_tokens = maxTokens;
  if (json) body.response_format = { type: 'json_object' };

  const headers = {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
  };

  for (let intento = 0; ; intento++) {
    try {
      const resp = await axios.post(ENDPOINT, body, { headers, timeout });
      return resp.data.choices[0].message.content.trim();
    } catch (err) {
      if (intento >= REINTENTOS || !esReintentable(err)) throw err;
      const pausa = pausaReintento(err, intento);
      console.warn(`[OpenAI] ${model} HTTP ${err.response.status}; reintento ${intento + 1}/${REINTENTOS} en ${Math.round(pausa / 1000)}s`);
      await esperar(pausa);
    }
  }
}

module.exports = { chat };
