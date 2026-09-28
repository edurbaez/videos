const { chat: chatOpenAI } = require('./openai');
const { LANG_NAMES } = require('../utils/constantes');
const { renderPrompt, leerPromptArchivo } = require('../utils/prompts');

// Neural2 / tts-1 hablan ~140 palabras por minuto en ritmo explicativo
const PALABRAS_POR_MINUTO = 140;
const MINUTOS_POR_SECCION = 2;

/** gpt-4o shorthand shared by the long-video and course pipelines. */
function chat(prompt, { maxTokens, temperature = 0.7, json = false }) {
  return chatOpenAI({ model: 'gpt-4o', prompt, maxTokens, temperature, json });
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

async function generarEsquema({ tema, idioma, nivel, minutos, formato, palabras }) {
  const { numSecciones } = planificar(minutos);
  const prompt = promptLargo('esquema.txt', {
    tema, nivel, minutos,
    idioma_nombre: LANG_NAMES[idioma],
    tipo_formato: formato === 'dialogo' ? 'two-voice dialogue' : 'single-narrator',
    palabras_linea: palabras ? `\nThese words/phrases must be taught across the lesson (distribute them among sections): ${palabras}\n` : '',
    num_secciones: numSecciones,
    minutos_por_seccion: MINUTOS_POR_SECCION,
  });

  const raw = await chat(prompt, { maxTokens: 3000, temperature: 0.6, json: true });
  const esquema = JSON.parse(raw);
  if (!Array.isArray(esquema.secciones) || esquema.secciones.length < 2) {
    throw new Error('El esquema generado no tiene secciones válidas.');
  }
  return esquema;
}

async function generarSeccion({ tema, idioma, nivel, formato, esquema, indice, palabrasObjetivo, textoAnterior }) {
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
    // Only the tail of the previous section: enough to link without bloating the prompt
    contexto: textoAnterior
      ? `\nThe previous section ended like this (continue naturally from here, do NOT repeat it):\n"""${textoAnterior.slice(-900)}"""\n`
      : '',
    reglas_formato: reglasFormato(formato),
    palabras_objetivo: palabrasObjetivo,
    palabras_min: Math.round(palabrasObjetivo * 0.9),
    palabras_max: Math.round(palabrasObjetivo * 1.1),
    regla_inicio: esPrimera ? 'Open with a short welcome and present what the lesson covers.' : 'Do NOT greet or welcome again; continue the lesson seamlessly.',
    regla_final: esUltima ? 'Close the lesson with a recap and a friendly goodbye.' : 'Do NOT say goodbye or conclude the lesson; end with a natural transition to the next section.',
  });

  let texto = await chat(prompt, { maxTokens: 2500 });
  let palabras = contarPalabras(texto);

  if (palabras < palabrasObjetivo * 0.75) {
    const reintento = prompt + promptLargo('seccion-reintento.txt', { palabras, palabras_objetivo: palabrasObjetivo });
    texto = await chat(reintento, { maxTokens: 2500 });
    palabras = contarPalabras(texto);
  }

  if (formato === 'dialogo') texto = normalizarDialogo(texto);
  return { titulo: seccion.titulo, texto, palabras };
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
 * @returns {{ titulo, secciones: [{titulo, texto, palabras}], palabrasTotales, palabrasObjetivo }}
 */
async function generarGuionLargo(opciones, onSeccion) {
  const { minutos } = opciones;
  const plan = planificar(minutos);
  const esquema = await generarEsquema(opciones);
  if (onSeccion) await onSeccion({ tipo: 'esquema', esquema });

  const secciones = [];
  for (let i = 0; i < esquema.secciones.length; i++) {
    const sec = await generarSeccion({
      ...opciones,
      esquema,
      indice: i,
      palabrasObjetivo: plan.palabrasPorSeccion,
      textoAnterior: secciones[i - 1]?.texto,
    });
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

module.exports = { generarGuionLargo, parsearDialogo, limpiarEtiquetas, planificar, chat, PALABRAS_POR_MINUTO };
