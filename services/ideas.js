const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { escribirJsonAtomico } = require('../utils/archivos');

const RAIZ = path.join(__dirname, '..');
const RUTA_CSV    = path.join(RAIZ, 'ideas.csv');
const RUTA_ESTADO = path.join(RAIZ, 'ideas-estado.json');

const MAX_IDEA = 300;
const PRIORIDAD_DEFAULT = 3;
const RE_ID = /^[a-zA-Z0-9_-]+$/;

/** Minimal RFC 4180 parser: quoted fields, escaped quotes ("") and newlines inside quotes. */
function parsearCsv(texto) {
  const filas = [];
  let fila = [], campo = '', comillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (comillas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') comillas = false;
      else campo += c;
    } else if (c === '"') comillas = true;
    else if (c === ',') { fila.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      fila.push(campo); filas.push(fila); fila = []; campo = '';
    } else campo += c;
  }
  if (campo || fila.length) { fila.push(campo); filas.push(fila); }
  return filas.filter(f => f.some(v => v.trim()));
}

const claveIdea = (nicho, ideaBase) =>
  crypto.createHash('sha1').update(`${nicho}|${ideaBase.toLowerCase()}`).digest('hex').slice(0, 16);

/**
 * Reads ideas.csv (read-only; header: nicho,idea_base,prioridad[,canal]).
 * Invalid rows are skipped. Priority 1 = highest.
 * @returns {{ clave, nicho, idea_base, prioridad, canal, orden }[]}
 */
function leerIdeas(rutaCsv = RUTA_CSV) {
  if (!fs.existsSync(rutaCsv)) return [];
  const filas = parsearCsv(fs.readFileSync(rutaCsv, 'utf-8').replace(/^\uFEFF/, ''));
  if (!filas.length) return [];

  const cabecera = filas[0].map(h => h.trim().toLowerCase());
  const col = nombre => cabecera.indexOf(nombre);
  const [iNicho, iIdea, iPrio, iCanal] = ['nicho', 'idea_base', 'prioridad', 'canal'].map(col);
  if (iNicho < 0 || iIdea < 0) throw new Error('ideas.csv debe tener las columnas "nicho" e "idea_base".');

  const ideas = [];
  filas.slice(1).forEach((f, orden) => {
    const nicho = (f[iNicho] || '').trim();
    const ideaBase = (f[iIdea] || '').replace(/[\u0000-\u001F\u007F]+/g, ' ').trim().slice(0, MAX_IDEA);
    if (!RE_ID.test(nicho) || !ideaBase) return;
    const prioridad = parseInt(iPrio >= 0 ? f[iPrio] : '', 10);
    const canal = iCanal >= 0 ? (f[iCanal] || '').trim() : '';
    ideas.push({
      clave: claveIdea(nicho, ideaBase),
      nicho,
      idea_base: ideaBase,
      prioridad: Number.isInteger(prioridad) && prioridad > 0 ? prioridad : PRIORIDAD_DEFAULT,
      canal: RE_ID.test(canal) ? canal : null,
      orden,
    });
  });
  return ideas;
}

function leerEstado(rutaEstado = RUTA_ESTADO) {
  try {
    const e = JSON.parse(fs.readFileSync(rutaEstado, 'utf-8'));
    return { usadas: e.usadas || {}, usoNicho: e.usoNicho || {}, ciclo: e.ciclo || 1 };
  } catch {
    return { usadas: {}, usoNicho: {}, ciclo: 1 };
  }
}

/**
 * Picks the unused idea with the highest priority. Among equal priorities, the niche used
 * longest ago wins (never-used first), then CSV order — so niches rotate.
 * When every valid idea has been used, the usage state is reset (new cycle).
 *
 * @param {{ rutaCsv?, rutaEstado?, nichosValidos?: Set<string> }} [opciones]
 *   nichosValidos - if given, ideas of other niches are ignored
 * @returns {object|null} the idea, or null if the CSV has no valid ideas
 */
function seleccionarIdea({ rutaCsv = RUTA_CSV, rutaEstado = RUTA_ESTADO, nichosValidos } = {}) {
  const ideas = leerIdeas(rutaCsv).filter(i => !nichosValidos || nichosValidos.has(i.nicho));
  if (!ideas.length) return null;

  const estado = leerEstado(rutaEstado);
  let libres = ideas.filter(i => !estado.usadas[i.clave]);
  if (!libres.length) {
    const claves = new Set(ideas.map(i => i.clave));
    for (const clave of Object.keys(estado.usadas)) if (claves.has(clave)) delete estado.usadas[clave];
    estado.ciclo++;
    escribirJsonAtomico(rutaEstado, estado);
    console.log(`[ideas] Todas las ideas usadas: se reinicia el ciclo (${estado.ciclo}).`);
    libres = ideas;
  }

  const usoNicho = n => estado.usoNicho[n] || '';
  libres.sort((a, b) => a.prioridad - b.prioridad || usoNicho(a.nicho).localeCompare(usoNicho(b.nicho)) || a.orden - b.orden);
  return libres[0];
}

/** Records an idea as used (only call after the pipeline succeeded). */
function marcarUsada(idea, { rutaEstado = RUTA_ESTADO, fecha = new Date() } = {}) {
  const estado = leerEstado(rutaEstado);
  const iso = fecha.toISOString();
  estado.usadas[idea.clave] = iso;
  estado.usoNicho[idea.nicho] = iso;
  escribirJsonAtomico(rutaEstado, estado);
}

function resumen({ rutaCsv = RUTA_CSV, rutaEstado = RUTA_ESTADO } = {}) {
  try {
    const ideas = leerIdeas(rutaCsv);
    const estado = leerEstado(rutaEstado);
    return { total: ideas.length, usadas: ideas.filter(i => estado.usadas[i.clave]).length, ciclo: estado.ciclo };
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { leerIdeas, seleccionarIdea, marcarUsada, resumen, parsearCsv };
