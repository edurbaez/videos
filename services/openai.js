const axios = require('axios');

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const TIMEOUT_MS = 120_000;
const TIMEOUT_RAZONAMIENTO_MS = 300_000;
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

// Reasoning models (o-series, GPT-5+) reject max_tokens and non-default temperature;
// "-chat-latest" aliases are non-reasoning chat models.
function esModeloRazonamiento(model) {
  return /^(o\d|gpt-([5-9]|\d{2}))/.test(model) && !/chat-latest/.test(model);
}

// Reasoning tokens count against max_completion_tokens, so the visible-output budget
// the caller asks for is topped up by a reserve that grows with the effort.
const RESERVA_RAZONAMIENTO = { none: 0, minimal: 1000, low: 4000, medium: 12_000, high: 25_000, xhigh: 40_000, max: 60_000 };

function construirBody({ model, prompt, messages, json, maxTokens, temperature, reasoningEffort }) {
  const body = { model, messages: messages || [{ role: 'user', content: prompt }] };
  if (json) body.response_format = { type: 'json_object' };
  if (!esModeloRazonamiento(model)) {
    if (temperature !== undefined) body.temperature = temperature;
    if (maxTokens !== undefined) body.max_tokens = maxTokens;
    return body;
  }
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  if (maxTokens !== undefined) {
    body.max_completion_tokens = maxTokens + (RESERVA_RAZONAMIENTO[reasoningEffort || 'medium'] ?? RESERVA_RAZONAMIENTO.medium);
  }
  return body;
}

/**
 * Chat Completions call with default timeout and backoff retry on 429/5xx.
 * Returns the trimmed message content; rethrows the original axios error otherwise.
 */
async function chat({ model, prompt, messages, json = false, maxTokens, temperature, reasoningEffort, timeout }) {
  if (!model) throw new Error('openai.chat: falta "model".');
  const body = construirBody({ model, prompt, messages, json, maxTokens, temperature, reasoningEffort });
  if (timeout === undefined) timeout = esModeloRazonamiento(model) ? TIMEOUT_RAZONAMIENTO_MS : TIMEOUT_MS;

  const headers = {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
  };

  for (let intento = 0; ; intento++) {
    try {
      const resp = await axios.post(ENDPOINT, body, { headers, timeout });
      const eleccion = resp.data.choices[0];
      const contenido = eleccion.message?.content;
      if (!contenido) {
        throw new Error(`openai.chat: ${model} devolvió respuesta vacía (finish_reason: ${eleccion.finish_reason || '?'}).`);
      }
      return contenido.trim();
    } catch (err) {
      if (intento >= REINTENTOS || !esReintentable(err)) throw err;
      const pausa = pausaReintento(err, intento);
      console.warn(`[OpenAI] ${model} HTTP ${err.response.status}; reintento ${intento + 1}/${REINTENTOS} en ${Math.round(pausa / 1000)}s`);
      await esperar(pausa);
    }
  }
}

module.exports = { chat, esModeloRazonamiento, construirBody };
