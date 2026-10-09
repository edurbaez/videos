const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const { ts } = require('../utils/log');

const LIMITE_WHISPER_BYTES = 25 * 1024 * 1024;
const SIMILITUD_MATCH = 0.75;
const CONFIANZA_MINIMA = 0.6;
const SEG_POR_PALABRA = 0.35;

/** Palabras con tiempos (s) de un audio vía Whisper. Devuelve [{ word, start, end }]. */
async function transcribirPalabras(rutaAudio, idioma = 'es') {
  const tamano = fs.statSync(rutaAudio).size;
  if (tamano >= LIMITE_WHISPER_BYTES) throw new Error(`audio de ${tamano} bytes supera el límite de Whisper`);

  const form = new FormData();
  form.append('file', fs.createReadStream(rutaAudio));
  form.append('model', 'whisper-1');
  form.append('language', /^[a-z]{2}$/.test(idioma) ? idioma : 'es');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');

  let resp;
  try {
    resp = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, ...form.getHeaders() },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 300_000,
    });
  } catch (err) {
    const detalle = err.response?.data ? JSON.stringify(err.response.data).slice(0, 300) : err.message;
    throw new Error(`Whisper HTTP ${err.response?.status}: ${detalle}`);
  }
  const palabras = resp.data?.words;
  if (!Array.isArray(palabras)) throw new Error('Whisper no devolvió palabras');
  return palabras;
}

function normalizarToken(t) {
  return String(t).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/ß/g, 'ss').replace(/[^\p{L}\p{N}]/gu, '');
}

function tokenizar(texto) {
  return texto.split(/\s+/).map(t => ({ texto: t, norm: normalizarToken(t) })).filter(t => t.norm);
}

function similitud(a, b) {
  if (a === b) return 1;
  const n = a.length, m = b.length;
  if (!n || !m) return 0;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[m] / Math.max(n, m);
}

/**
 * Alineación global (tipo Needleman-Wunsch) entre tokens del guion y de Whisper.
 * Devuelve, por token del guion, el índice de palabra Whisper asignada (o -1) y su similitud.
 */
function alinearTokens(guion, whisper) {
  const n = guion.length, m = whisper.length;
  const GAP = 1;
  // A substitution (e.g. "3" vs "drei") is cheaper than two gaps so it still lends its timing
  const coste = s => (s >= SIMILITUD_MATCH ? (1 - s) * 0.5 : 1.5);
  const paso = new Uint8Array((n + 1) * (m + 1)); // 0 diag, 1 up (gap whisper), 2 left (gap guion)
  let prev = new Float64Array(m + 1);
  for (let j = 1; j <= m; j++) { prev[j] = j * GAP; paso[j] = 2; }
  for (let i = 1; i <= n; i++) {
    const cur = new Float64Array(m + 1);
    cur[0] = i * GAP;
    paso[i * (m + 1)] = 1;
    for (let j = 1; j <= m; j++) {
      const s = similitud(guion[i - 1].norm, whisper[j - 1].norm);
      const diag = prev[j - 1] + coste(s);
      const arriba = prev[j] + GAP;
      const izq = cur[j - 1] + GAP;
      if (diag <= arriba && diag <= izq) { cur[j] = diag; paso[i * (m + 1) + j] = 0; }
      else if (arriba <= izq) { cur[j] = arriba; paso[i * (m + 1) + j] = 1; }
      else { cur[j] = izq; paso[i * (m + 1) + j] = 2; }
    }
    prev = cur;
  }

  const asignado = new Array(n).fill(-1);
  const simAsignada = new Array(n).fill(0);
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const p = paso[i * (m + 1) + j];
    if (i > 0 && j > 0 && p === 0) {
      asignado[i - 1] = j - 1;
      simAsignada[i - 1] = similitud(guion[i - 1].norm, whisper[j - 1].norm);
      i--; j--;
    } else if (i > 0 && (j === 0 || p === 1)) i--;
    else j--;
  }
  return { asignado, simAsignada };
}

/**
 * Alinea oraciones conocidas del guion con las palabras de Whisper (tiempos relativos al audio).
 *
 * @param {string[]} oraciones
 * @param {{word: string, start: number, end: number}[]} palabrasWhisper
 * @param {number} [duracion] - Duración del audio, para acotar tiempos interpolados al final
 * @returns {{ confianza: number, oraciones: { inicio, fin, palabras: { texto, inicio, fin }[] }[] }}
 */
function alinearOraciones(oraciones, palabrasWhisper, duracion = Infinity) {
  const tokens = [];
  oraciones.forEach((o, k) => tokenizar(o).forEach(t => tokens.push({ ...t, oracion: k })));
  const whisper = palabrasWhisper
    .map(w => ({ norm: normalizarToken(w.word), start: Number(w.start), end: Number(w.end) }))
    .filter(w => w.norm && Number.isFinite(w.start) && Number.isFinite(w.end));

  if (!tokens.length || !whisper.length) {
    return { confianza: 0, oraciones: oraciones.map(() => ({ inicio: 0, fin: 0, palabras: [] })) };
  }

  const { asignado, simAsignada } = alinearTokens(tokens, whisper);
  const confianza = simAsignada.filter(s => s >= SIMILITUD_MATCH).length / tokens.length;

  tokens.forEach((t, k) => {
    if (asignado[k] >= 0) { t.inicio = whisper[asignado[k]].start; t.fin = whisper[asignado[k]].end; }
  });

  // Unmatched tokens: spread by length over the gap between their timed neighbours
  const finAudio = Number.isFinite(duracion) ? duracion : whisper[whisper.length - 1].end;
  for (let k = 0; k < tokens.length;) {
    if (tokens[k].inicio !== undefined) { k++; continue; }
    let f = k;
    while (f < tokens.length && tokens[f].inicio === undefined) f++;
    // Leading/trailing runs get ~SEG_POR_PALABRA each instead of absorbing silences
    let desde, hasta;
    if (k > 0 && f < tokens.length) { desde = tokens[k - 1].fin; hasta = tokens[f].inicio; }
    else if (k > 0) { desde = tokens[k - 1].fin; hasta = Math.max(desde, Math.min(finAudio, desde + SEG_POR_PALABRA * (f - k))); }
    else { hasta = f < tokens.length ? tokens[f].inicio : finAudio; desde = Math.max(0, hasta - SEG_POR_PALABRA * (f - k)); }
    const largo = tokens.slice(k, f).reduce((a, t) => a + t.norm.length, 0);
    let t0 = desde;
    for (let x = k; x < f; x++) {
      const d = Math.max(0, hasta - desde) * tokens[x].norm.length / largo;
      tokens[x].inicio = t0; tokens[x].fin = t0 + d; t0 += d;
    }
    k = f;
  }

  // Monotonic, non-overlapping word times
  let ultimoFin = 0;
  for (const t of tokens) {
    t.inicio = Math.max(t.inicio, ultimoFin);
    t.fin = Math.min(Math.max(t.fin, t.inicio), finAudio);
    if (t.fin < t.inicio) t.fin = t.inicio;
    ultimoFin = t.fin;
  }

  const resultado = oraciones.map((_, k) => {
    const propios = tokens.filter(t => t.oracion === k);
    if (!propios.length) return null;
    return {
      inicio: propios[0].inicio,
      fin: propios[propios.length - 1].fin,
      palabras: propios.map(t => ({ texto: t.texto, inicio: t.inicio, fin: t.fin })),
    };
  });
  // Sentences with no tokens (only punctuation): zero-length at the previous end
  let anterior = 0;
  const final = resultado.map(r => {
    if (r) { anterior = r.fin; return r; }
    return { inicio: anterior, fin: anterior, palabras: [] };
  });
  return { confianza, oraciones: final };
}

/** Reparte tiempos de palabra proporcionalmente a su longitud dentro de [inicio, fin]. */
function estimarPalabras(texto, inicio, fin) {
  const tokens = texto.split(/\s+/).filter(Boolean);
  const total = tokens.reduce((a, t) => a + t.length, 0) || 1;
  let t0 = inicio;
  return tokens.map(t => {
    const d = (fin - inicio) * t.length / total;
    const p = { texto: t, inicio: t0, fin: t0 + d };
    t0 += d;
    return p;
  });
}

/**
 * Tiempos reales de cada oración de un audio. Devuelve null si Whisper falla o la confianza es baja.
 */
async function alinearAudio(rutaAudio, oraciones, idioma, duracion) {
  try {
    const palabras = await transcribirPalabras(rutaAudio, idioma);
    const r = alinearOraciones(oraciones, palabras, duracion);
    if (r.confianza < CONFIANZA_MINIMA) {
      console.warn(`[${ts()}] Alineación: confianza baja (${r.confianza.toFixed(2)}) en ${rutaAudio}; se usa la estimación.`);
      return null;
    }
    console.log(`[${ts()}] Alineación: ${oraciones.length} oraciones, confianza ${r.confianza.toFixed(2)}.`);
    return r;
  } catch (err) {
    console.warn(`[${ts()}] Alineación: falló (${err.message}); se usa la estimación.`);
    return null;
  }
}

module.exports = { transcribirPalabras, alinearOraciones, alinearAudio, estimarPalabras, normalizarToken, CONFIANZA_MINIMA };
