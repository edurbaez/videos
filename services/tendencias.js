const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const { ts } = require('../utils/log');

const TIMEOUT_MS = 10_000;
const MAX_RESPUESTA = 2 * 1024 * 1024;
const MAX_TITULAR = 120;
const ANTIGUEDAD_MAX_MS = 3 * 24 * 60 * 60 * 1000;

// Google News edition per niche language (hl, gl, ceid)
const EDICIONES = {
  es: { hl: 'es-419', gl: 'MX', ceid: 'MX:es' },
  en: { hl: 'en-US',  gl: 'US', ceid: 'US:en' },
  de: { hl: 'de',     gl: 'DE', ceid: 'DE:de' },
  fr: { hl: 'fr',     gl: 'FR', ceid: 'FR:fr' },
  pt: { hl: 'pt-BR',  gl: 'BR', ceid: 'BR:pt-419' },
  it: { hl: 'it',     gl: 'IT', ceid: 'IT:it' },
};

const parser = new XMLParser({ ignoreAttributes: true, processEntities: true, htmlEntities: true });

/**
 * Makes an external headline safe to embed as context in a prompt: drops the " - Source" suffix,
 * URLs, markup, control characters and delimiter-like symbols, collapses whitespace and truncates.
 */
function sanitizarTitular(texto) {
  if (typeof texto !== 'string') return '';
  let t = texto
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2066-\u2069\uFEFF]/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/\b[\w-]+(?:\.[\w-]+)+\/\S*/g, ' ')
    .replace(/[<>{}[\]`"«»|\\*#_~^$]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  t = t.replace(/\s+[-–—|]\s+[^-–—|]{2,60}$/, '').trim();
  if (t.length > MAX_TITULAR) t = t.slice(0, MAX_TITULAR).replace(/\s+\S*$/, '').trim();
  return t.length >= 10 ? t : '';
}

/**
 * Latest Google News headline (RSS) for a keyword, or '' if none / on any failure.
 * Only headlines published in the last 3 days are considered.
 */
async function tendenciaGoogleNews(keyword, idioma = 'es') {
  const ed = EDICIONES[idioma] || EDICIONES.es;
  const url = 'https://news.google.com/rss/search';
  const { data } = await axios.get(url, {
    params: { q: `${keyword} when:2d`, hl: ed.hl, gl: ed.gl, ceid: ed.ceid },
    timeout: TIMEOUT_MS,
    maxContentLength: MAX_RESPUESTA,
    maxRedirects: 3,
    responseType: 'text',
    headers: { 'User-Agent': 'Mozilla/5.0 (generador-shorts)' },
  });
  const items = [].concat(parser.parse(String(data))?.rss?.channel?.item || []);
  const ahora = Date.now();
  for (const item of items) {
    const fecha = Date.parse(item.pubDate);
    if (Number.isFinite(fecha) && ahora - fecha > ANTIGUEDAD_MAX_MS) continue;
    const titular = sanitizarTitular(String(item.title ?? ''));
    if (titular) return titular;
  }
  return '';
}

/**
 * Trend context for an idea. Never throws: returns '' when trends are disabled for the niche
 * (automatizacion.tendencias === false, e.g. salud_*) or the source fails.
 * YouTube mostPopular is intentionally not used: it is not keyword-related and spends channel quota.
 */
async function obtenerTendencia(keyword, nichoConfig = {}) {
  if (nichoConfig.automatizacion?.tendencias === false) return '';
  try {
    const titular = await tendenciaGoogleNews(String(keyword).slice(0, 120), nichoConfig.idioma);
    console.log(`[${ts()}] Tendencias: ${titular ? `"${titular}"` : 'sin resultados'} para "${keyword}"`);
    return titular;
  } catch (err) {
    console.warn(`[${ts()}] Tendencias: Google News falló (${err.code || err.message}), se sigue sin tendencia.`);
    return '';
  }
}

module.exports = { obtenerTendencia, sanitizarTitular, tendenciaGoogleNews };
