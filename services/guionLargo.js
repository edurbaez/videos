const { chat: chatOpenAI } = require('./openai');
const { LANG_NAMES } = require('../utils/constantes');
const { renderPrompt, leerPromptArchivo } = require('../utils/prompts');

// Neural2 / tts-1 hablan ~140 palabras por minuto en ritmo explicativo
const PALABRAS_POR_MINUTO = 140;
const MINUTOS_POR_SECCION = 2;

const MODELO_GUION_DEFAULT = 'gpt-6.1-sol';
const MODELO_AUX_DEFAULT = 'gpt-4o';
const MARCA_EJEMPLOS = '###EJEMPLOS###';
const MAX_EJEMPLOS_USADOS = 40;

// Read at call time: a script may require this module before loading dotenv.
const modeloGuion = () => process.env.OPENAI_MODELO_GUION || MODELO_GUION_DEFAULT;

/**
 * Shared helper for the auxiliary calls (art director, course scripts): short JSON/text tasks
 * where gpt-4o is cheap, fast and honours temperature. Override with OPENAI_MODELO_LARGO_AUX.
 */
function chat(prompt, { maxTokens, temperature = 0.7, json = false, model, reasoningEffort }) {
  const modelo = model || process.env.OPENAI_MODELO_LARGO_AUX || MODELO_AUX_DEFAULT;
  return chatOpenAI({ model: modelo, prompt, maxTokens, temperature, json, reasoningEffort });
}

function chatGuion(prompt, opciones) {
  return chat(prompt, { ...opciones, model: modeloGuion() });
}

function contarPalabras(texto) {
  return texto.replace(/^\s*[FM]\s*:/gm, ' ').split(/\s+/).filter(Boolean).length;
}

/** Quita las etiquetas de hablante del diálogo (para metadatos/lectura). */
function limpiarEtiquetas(texto) {
  return texto.replace(/^\s*[FM]\s*:\s*/gm, '');
}

function planificar(minutos) {
  const numSecciones = Math.max(3, Math.round(minutos / MINUTOS_POR_SECCION));
  const palabrasTotales = Math.round(minutos * PALABRAS_POR_MINUTO);
  return { numSecciones, palabrasPorSeccion: Math.round(palabrasTotales / numSecciones), palabrasTotales };
}

const promptLargo = (archivo, vars) => renderPrompt(leerPromptArchivo('largo', archivo), vars).replace(/\s+$/, '');

function reglasFormato(formato) {
  return promptLargo(formato === 'dialogo' ? 'formato-dialogo.txt' : 'formato-monologo.txt', {});
}

/** Trimmed single-line string capped at `max` chars; anything else → ''. */
function texto(valor, max) {
  if (typeof valor !== 'string' && typeof valor !== 'number') return '';
  const limpio = String(valor).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return limpio.length > max ? limpio.slice(0, max - 1).trimEnd() + '…' : limpio;
}

function listaTextos(valor, maxItems, maxLen) {
  if (!Array.isArray(valor)) return [];
  return valor.map(v => texto(v, maxLen)).filter(Boolean).slice(0, maxItems);
}

function esObjeto(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function sanitizarTabla(t) {
  if (!esObjeto(t)) return null;
  const columnas = listaTextos(t.columnas, 5, 30);
  if (!columnas.length || !Array.isArray(t.filas)) return null;
  const filas = t.filas
    .filter(f => Array.isArray(f) && f.length === columnas.length)
    .map(f => f.map(c => texto(c, 40)))
    .filter(f => f.some(Boolean))
    .slice(0, 8);
  if (!filas.length) return null;
  return { titulo: texto(t.titulo, 60), columnas, filas };
}

function sanitizarQuiz(q) {
  if (!esObjeto(q)) return null;
  const pregunta = texto(q.pregunta, 140);
  if (!pregunta || !Array.isArray(q.opciones) || q.opciones.length < 2 || q.opciones.length > 4) return null;
  const opciones = q.opciones.map(o => texto(o, 80));
  const correcta = typeof q.correcta === 'number' ? q.correcta : NaN;
  if (opciones.some(o => !o) || !Number.isInteger(correcta) || correcta < 0 || correcta >= opciones.length) return null;
  return { pregunta, opciones, correcta };
}

/**
 * On-screen data for a section (animated cards). Untrusted model output: every field is
 * type-checked and size-capped; returns null when nothing usable remains.
 */
function sanitizarVisual(v) {
  if (!esObjeto(v)) return null;
  const ejemplos = (Array.isArray(v.ejemplos) ? v.ejemplos : [])
    .map(e => (esObjeto(e)
      ? { texto: texto(e.texto, 140), traduccion: texto(e.traduccion, 140) || null }
      : { texto: texto(e, 140), traduccion: null }))
    .filter(e => e.texto)
    .slice(0, 4);
  const visual = {
    puntosClave: listaTextos(v.puntosClave, 4, 80),
    ejemplos,
    tabla: sanitizarTabla(v.tabla),
    quiz: sanitizarQuiz(v.quiz),
  };
  const vacio = !visual.puntosClave.length && !visual.ejemplos.length && !visual.tabla && !visual.quiz;
  return vacio ? null : visual;
}

/** Splits the model output into the spoken text and the trailing list of example sentences. */
function separarEjemplos(salida) {
  const i = salida.indexOf(MARCA_EJEMPLOS);
  if (i === -1) return { texto: salida.trim(), ejemplos: [] };
  const ejemplos = salida.slice(i + MARCA_EJEMPLOS.length).split('\n')
    .map(l => texto(l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/^["„“«]+|["“”»]+$/g, ''), 200))
    .filter(Boolean);
  return { texto: salida.slice(0, i).trim(), ejemplos };
}

function lineaLista(items) {
  return items.length ? items.map(e => `"${e}"`).join(' | ') : '(none)';
}

function describirTablaQuiz(visual) {
  let out = '';
  if (visual?.tabla) {
    out += `A table is shown on screen ("${visual.tabla.titulo}": ${visual.tabla.columnas.join(' / ')}); explain its content (do not describe its columns or layout).\n`;
  }
  if (visual?.quiz) {
    const { pregunta, opciones, correcta } = visual.quiz;
    out += `Include this quiz as a pattern interrupt (ask it, give a moment to think, then the answer): ${pregunta} Options: ${opciones.join(' / ')}. Correct: ${opciones[correcta]}.\n`;
  }
  return out;
}

async function generarEsquema({ tema, idioma, nivel, minutos, formato, palabras }) {
  const { numSecciones } = planificar(minutos);
  const prompt = promptLargo('esquema.txt', {
    tema, nivel, minutos,
    idioma_nombre: LANG_NAMES[idioma],
    tipo_formato: formato === 'dialogo' ? 'two-voice dialogue' : 'single-narrator',
    palabras_linea: palabras ? `\nThese words/phrases must be taught across the lesson (distribute them among sections): ${palabras}\n` : '',
    num_secciones: numSecciones,
    minutos_por_seccion: Math.round(minutos / numSecciones * 10) / 10,
  });

  const raw = await chatGuion(prompt, { maxTokens: 6000, temperature: 0.6, json: true, reasoningEffort: 'medium' });
  const esquema = JSON.parse(raw);
  if (!Array.isArray(esquema.secciones) || esquema.secciones.length < 2) {
    throw new Error('El esquema generado no tiene secciones válidas.');
  }
  esquema.titulo = texto(esquema.titulo, 120) || texto(tema, 120);
  esquema.secciones = esquema.secciones.map((s, i) => ({
    titulo: texto(s?.titulo, 100) || String(i + 1),
    contenido: texto(Array.isArray(s?.contenido) ? s.contenido.join('; ') : s?.contenido, 1500),
    visual: sanitizarVisual(s?.visual),
  }));
  return esquema;
}

async function generarSeccion({ tema, idioma, nivel, formato, esquema, indice, palabrasObjetivo, textoAnterior, ejemplosUsados = [] }) {
  const total = esquema.secciones.length;
  const seccion = esquema.secciones[indice];
  const esPrimera = indice === 0;
  const esUltima = indice === total - 1;

  const prompt = promptLargo('seccion.txt', {
    tema, nivel, total,
    numero: indice + 1,
    idioma_nombre: LANG_NAMES[idioma],
    titulo_leccion: esquema.titulo,
    indice: esquema.secciones.map((s, i) => `${i + 1}. ${s.titulo}${i === indice ? '  ← CURRENT' : ''}`).join('\n'),
    titulo_seccion: seccion.titulo,
    contenido: seccion.contenido,
    puntos_clave: lineaLista(seccion.visual?.puntosClave || []),
    ejemplos_obligatorios: lineaLista((seccion.visual?.ejemplos || []).map(e => e.texto)),
    tabla_quiz: describirTablaQuiz(seccion.visual),
    ejemplos_usados: ejemplosUsados.length
      ? `Example sentences already used in previous sections (do NOT reuse them${esUltima ? ', except briefly in the final recap' : ''}): ${lineaLista(ejemplosUsados.slice(-MAX_EJEMPLOS_USADOS))}\n`
      : '',
    // Only the tail of the previous section: enough to link without bloating the prompt
    contexto: textoAnterior
      ? `\nThe previous section ended like this (continue naturally from here, do NOT repeat it):\n"""${textoAnterior.slice(-900)}"""\n`
      : '',
    reglas_formato: reglasFormato(formato),
    palabras_objetivo: palabrasObjetivo,
    palabras_min: Math.round(palabrasObjetivo * 0.9),
    palabras_max: Math.round(palabrasObjetivo * 1.1),
    regla_inicio: esPrimera
      ? 'Opening: the very first 1-2 sentences are a concrete hook (a common mistake, a surprising contrast, a real-life situation or exactly what the viewer will be able to say after this video). Never start with a welcome or "today we will learn". After the hook, at most one short welcome sentence, then a roadmap in one or two sentences.'
      : 'Do NOT greet or welcome again; continue the lesson seamlessly.',
    regla_final: esUltima ? 'Close the lesson with a fast recap of the key rules, a final challenge with its answers, and a short friendly goodbye.' : 'Do NOT say goodbye or conclude the lesson; end with a natural one-sentence transition to the next section.',
  });

  const maxTokens = Math.max(2500, palabrasObjetivo * 3 + 600);
  let salida = separarEjemplos(await chatGuion(prompt, { maxTokens, reasoningEffort: 'low' }));
  let palabras = contarPalabras(salida.texto);

  if (palabras < palabrasObjetivo * 0.75) {
    const reintento = prompt + promptLargo('seccion-reintento.txt', { palabras, palabras_objetivo: palabrasObjetivo });
    salida = separarEjemplos(await chatGuion(reintento, { maxTokens, reasoningEffort: 'low' }));
    palabras = contarPalabras(salida.texto);
  }

  const textoFinal = formato === 'dialogo' ? normalizarDialogo(salida.texto) : salida.texto;
  return { titulo: seccion.titulo, texto: textoFinal, palabras, visual: seccion.visual, ejemplos: salida.ejemplos };
}

/** Garantiza que cada línea empiece por "F:" o "M:"; líneas sueltas se unen al turno anterior. */
function normalizarDialogo(texto) {
  const turnos = parsearDialogo(texto);
  return turnos.map(t => `${t.voz}: ${t.texto}`).join('\n');
}

function parsearDialogo(texto) {
  const turnos = [];
  for (const linea of texto.split('\n')) {
    const l = linea.trim();
    if (!l) continue;
    const m = l.match(/^\**\s*([FM])\s*\**\s*:\s*\**\s*(.+)$/);
    if (m) {
      turnos.push({ voz: m[1], texto: m[2].trim() });
    } else if (turnos.length) {
      turnos[turnos.length - 1].texto += ' ' + l;
    } else {
      turnos.push({ voz: 'F', texto: l });
    }
  }
  return turnos;
}

/**
 * Genera el guion completo por secciones, secuencialmente para mantener coherencia.
 * Modelo: OPENAI_MODELO_GUION (esquema + secciones).
 * @returns {{ titulo, secciones: [{titulo, texto, palabras, visual, ejemplos}], palabrasTotales, palabrasObjetivo }}
 *   visual: null | { puntosClave: string[], ejemplos: [{texto, traduccion}], tabla: null|{titulo, columnas, filas}, quiz: null|{pregunta, opciones, correcta} }
 */
async function generarGuionLargo(opciones, onSeccion) {
  const { minutos } = opciones;
  const plan = planificar(minutos);
  const esquema = await generarEsquema(opciones);
  if (onSeccion) await onSeccion({ tipo: 'esquema', esquema });

  const secciones = [];
  const ejemplosUsados = [];
  const anotar = lista => lista.forEach(e => { if (!ejemplosUsados.includes(e)) ejemplosUsados.push(e); });
  for (let i = 0; i < esquema.secciones.length; i++) {
    const sec = await generarSeccion({
      ...opciones,
      esquema,
      indice: i,
      palabrasObjetivo: plan.palabrasPorSeccion,
      textoAnterior: secciones[i - 1]?.texto,
      ejemplosUsados: [...ejemplosUsados],
    });
    anotar((sec.visual?.ejemplos || []).map(e => e.texto));
    anotar(sec.ejemplos);
    secciones.push(sec);
    if (onSeccion) await onSeccion({ tipo: 'seccion', indice: i, total: esquema.secciones.length, seccion: sec });
  }

  return {
    titulo: esquema.titulo,
    secciones,
    palabrasTotales: secciones.reduce((a, s) => a + s.palabras, 0),
    palabrasObjetivo: plan.palabrasTotales,
  };
}

module.exports = {
  generarGuionLargo, parsearDialogo, limpiarEtiquetas, planificar, chat, PALABRAS_POR_MINUTO,
  sanitizarVisual, separarEjemplos,
};
