const axios = require('axios');
require('dotenv').config();

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
// Neural2 / tts-1 hablan ~140 palabras por minuto en ritmo explicativo
const PALABRAS_POR_MINUTO = 140;
const MINUTOS_POR_SECCION = 2;

const LANG_NAMES = {
  de: 'German (Deutsch)', en: 'English', es: 'Spanish (Español)',
  fr: 'French (Français)', pt: 'Portuguese (Português)',
};

function headers() {
  return {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function chat(prompt, { maxTokens, temperature = 0.7, json = false }) {
  const resp = await axios.post(ENDPOINT, {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    temperature,
    max_tokens: maxTokens,
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  }, { headers: headers() });
  return resp.data.choices[0].message.content.trim();
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

function reglasFormato(formato) {
  if (formato === 'dialogo') {
    return `FORMAT — two-voice dialogue:
- Two speakers: "F" (female teacher who explains) and "M" (male learner who asks questions, tries examples, makes typical mistakes that F corrects).
- EVERY line must start with "F:" or "M:" followed by the spoken text. One turn per line. No other lines.
- Keep turns natural: F explains in depth; M's turns are shorter but meaningful.`;
  }
  return `FORMAT — single narrator:
- Continuous spoken text by one teacher. Plain paragraphs separated by blank lines.`;
}

async function generarEsquema({ tema, idioma, nivel, minutos, formato, palabras }) {
  const langName = LANG_NAMES[idioma];
  const { numSecciones } = planificar(minutos);
  const palabrasLine = palabras ? `\nThese words/phrases must be taught across the lesson (distribute them among sections): ${palabras}\n` : '';

  const prompt = `You are an expert language teacher designing a ${minutos}-minute ${formato === 'dialogo' ? 'two-voice dialogue' : 'single-narrator'} video lesson for learners of ${langName}, level ${nivel}.

Topic: ${tema}
${palabrasLine}
Design a coherent lesson plan with EXACTLY ${numSecciones} sections, each about ${MINUTOS_POR_SECCION} minutes of speech.
- Section 1: introduction (what will be learned and why it matters).
- Middle sections: progress from simple to complex. Each section covers ONE clear sub-topic with explanation, examples and mini-practice. No repeated content between sections.
- Last section: recap of key points and a short practice/challenge for the viewer.

Return JSON: {"titulo": "<lesson title in ${langName}>", "secciones": [{"titulo": "<short section title in ${langName}>", "contenido": "<3-5 concrete points to cover, in English>"}]}`;

  const raw = await chat(prompt, { maxTokens: 3000, temperature: 0.6, json: true });
  const esquema = JSON.parse(raw);
  if (!Array.isArray(esquema.secciones) || esquema.secciones.length < 2) {
    throw new Error('El esquema generado no tiene secciones válidas.');
  }
  return esquema;
}

async function generarSeccion({ tema, idioma, nivel, formato, esquema, indice, palabrasObjetivo, textoAnterior }) {
  const langName = LANG_NAMES[idioma];
  const total = esquema.secciones.length;
  const seccion = esquema.secciones[indice];
  const indiceTexto = esquema.secciones.map((s, i) => `${i + 1}. ${s.titulo}${i === indice ? '  ← CURRENT' : ''}`).join('\n');
  const esPrimera = indice === 0;
  const esUltima = indice === total - 1;

  // Solo el final de la sección anterior: suficiente para enlazar sin inflar el prompt
  const contexto = textoAnterior
    ? `\nThe previous section ended like this (continue naturally from here, do NOT repeat it):\n"""${textoAnterior.slice(-900)}"""\n`
    : '';

  const prompt = `You are writing section ${indice + 1} of ${total} of a spoken video lesson for learners of ${langName}, level ${nivel}.

⚠ MANDATORY LANGUAGE: the spoken text must be 100% in ${langName}. No words from other languages.

Lesson: "${esquema.titulo}" (topic: ${tema})
Lesson outline:
${indiceTexto}

CURRENT SECTION: "${seccion.titulo}"
Points to cover: ${seccion.contenido}
${contexto}
${reglasFormato(formato)}

Rules:
- Length: about ${palabrasObjetivo} words (between ${Math.round(palabrasObjetivo * 0.9)} and ${Math.round(palabrasObjetivo * 1.1)}). This is important: the video duration depends on it.
- Explain in depth: clear explanation, several concrete examples, and a short practice moment for the viewer.
- Vocabulary and grammar adapted to level ${nivel}.
- Written for text-to-speech: no markdown, no emojis, no bullet points, no headings, no stage directions.
- ${esPrimera ? 'Open with a short welcome and present what the lesson covers.' : 'Do NOT greet or welcome again; continue the lesson seamlessly.'}
- ${esUltima ? 'Close the lesson with a recap and a friendly goodbye.' : 'Do NOT say goodbye or conclude the lesson; end with a natural transition to the next section.'}
- Output ONLY the spoken text.`;

  let texto = await chat(prompt, { maxTokens: 2500 });
  let palabras = contarPalabras(texto);

  if (palabras < palabrasObjetivo * 0.75) {
    const reintento = `${prompt}\n\nYour previous attempt had only ${palabras} words. Rewrite it with about ${palabrasObjetivo} words, expanding explanations and examples.`;
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

module.exports = { generarGuionLargo, parsearDialogo, limpiarEtiquetas, planificar, chat, LANG_NAMES, PALABRAS_POR_MINUTO };
