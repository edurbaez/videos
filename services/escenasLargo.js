const fs = require('fs');
const path = require('path');

const { chat, LANG_NAMES } = require('./guionLargo');
const { llamarOpenAIImagen, llamarGoogleImagen } = require('./imagenes');
const { renderPrompt } = require('../utils/prompts');

const DIR_PROMPTS = path.join(__dirname, '..', 'prompts', 'largo');
const ESCENAS_POR_LOTE = 12;
const CONCURRENCIA_LOTES = 3;
const CONCURRENCIA_IMAGENES = 3;
const MAX_CHARS_TEXTO = 60;
// Por debajo de esta fracción del objetivo, la última escena de una sección se funde con la anterior
const FRACCION_MINIMA = 0.4;

const leerPrompt = nombre => fs.readFileSync(path.join(DIR_PROMPTS, nombre), 'utf-8');

async function ejecutarConLimite(tareas, limite) {
  let siguiente = 0;
  const trabajadores = Array.from({ length: Math.min(limite, tareas.length) }, async () => {
    while (siguiente < tareas.length) {
      const i = siguiente++;
      await tareas[i]();
    }
  });
  await Promise.all(trabajadores);
}

/**
 * Agrupa la línea de tiempo por oraciones en escenas de ~segundosObjetivo sin cruzar secciones.
 * Las escenas resultantes cubren el audio completo sin huecos.
 */
function agruparEscenas(segmentos, segundosObjetivo, duracionTotal) {
  const escenas = [];
  let actual = null;
  for (const seg of segmentos) {
    const cerrar = !actual
      || seg.seccion !== actual.seccion
      || (seg.fin - actual.inicio > segundosObjetivo && seg.inicio - actual.inicio >= segundosObjetivo * 0.5);
    if (cerrar) {
      actual = { seccion: seg.seccion, inicio: seg.inicio, fin: seg.fin, segmentos: [] };
      escenas.push(actual);
    }
    actual.segmentos.push(seg);
    actual.fin = seg.fin;
  }

  for (let i = escenas.length - 1; i > 0; i--) {
    const e = escenas[i];
    const prev = escenas[i - 1];
    const esUltimaDeSeccion = !escenas[i + 1] || escenas[i + 1].seccion !== e.seccion;
    if (esUltimaDeSeccion && prev.seccion === e.seccion && e.fin - e.inicio < segundosObjetivo * FRACCION_MINIMA) {
      prev.segmentos.push(...e.segmentos);
      prev.fin = e.fin;
      escenas.splice(i, 1);
    }
  }

  return escenas.map((e, i) => ({
    n: i + 1,
    seccion: e.seccion,
    inicio: i === 0 ? 0 : e.segmentos[0].inicio,
    fin: i === escenas.length - 1 ? duracionTotal : escenas[i + 1].segmentos[0].inicio,
    texto: e.segmentos.map(s => (s.voz ? `${s.voz}: ` : '') + s.texto).join(' '),
  }));
}

async function generarGuiaEstilo({ titulo, tema, idioma, nivel, formato, secciones }) {
  const personajes = formato === 'dialogo'
    ? 'two recurring characters that appear in most scenes: "F", a female teacher who explains, and "M", a male learner who asks and practices. Describe both precisely (age, hair, clothing, colors) so they look identical in every image.'
    : 'optionally one recurring teacher/guide character; describe precisely if used.';
  const prompt = renderPrompt(leerPrompt('director-estilo.txt'), {
    titulo, tema, nivel,
    idioma: LANG_NAMES[idioma],
    formato: formato === 'dialogo' ? 'two-voice dialogue' : 'single narrator',
    secciones: secciones.map((s, i) => `${i + 1}. ${s.titulo}`).join('\n'),
    personajes,
  });
  const guia = JSON.parse(await chat(prompt, { maxTokens: 800, temperature: 0.5, json: true }));
  if (!guia.estilo) throw new Error('El director de arte no devolvió una guía de estilo.');
  return { estilo: String(guia.estilo), personajes: String(guia.personajes || '') };
}

function textoGuia(guia) {
  return guia.personajes ? `${guia.estilo}\nRecurring characters: ${guia.personajes}` : guia.estilo;
}

/** ASS usa llaves y barra invertida como marcado; se neutralizan. */
function limpiarTextoPantalla(texto) {
  return String(texto || '').replace(/[{}\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS_TEXTO);
}

async function dirigirLote(lote, guia, { titulo, idioma, formato }) {
  const prompt = renderPrompt(leerPrompt('director-escenas.txt'), {
    titulo,
    idioma: LANG_NAMES[idioma],
    guia: textoGuia(guia),
    cantidad: lote.length,
    formatoNota: formato === 'dialogo' ? 'F = female teacher, M = male learner' : 'single narrator',
    escenas: lote.map((e, i) => `Scene ${i + 1}:\n"""${e.texto}"""`).join('\n\n'),
  });
  const resp = JSON.parse(await chat(prompt, { maxTokens: 400 * lote.length, temperature: 0.7, json: true }));
  const items = Array.isArray(resp.escenas) ? resp.escenas : [];
  lote.forEach((e, i) => {
    const item = items.find(it => Number(it.n) === i + 1) || items[i] || {};
    e.prompt = String(item.prompt || '').trim()
      || `A scene illustrating this part of the lesson: ${e.texto.slice(0, 300)}`;
    e.textoPantalla = limpiarTextoPantalla(item.texto);
  });
}

/**
 * Paso agéntico: define la guía de estilo del video y un prompt + texto en pantalla por escena.
 * Muta cada escena añadiendo { prompt, textoPantalla }.
 */
async function dirigirArte(escenas, ctx) {
  const guia = await generarGuiaEstilo(ctx);
  const lotes = [];
  for (let i = 0; i < escenas.length; i += ESCENAS_POR_LOTE) lotes.push(escenas.slice(i, i + ESCENAS_POR_LOTE));
  await ejecutarConLimite(lotes.map(lote => () => dirigirLote(lote, guia, ctx)), CONCURRENCIA_LOTES);
  return guia;
}

function componerPrompt(guia, escena) {
  return `${textoGuia(guia)}

Scene: ${escena.prompt}

Strict rules: absolutely no text, letters, words, numbers, labels or logos anywhere in the image. Horizontal 16:9 composition. Keep the bottom fifth of the frame visually calm, a caption will be overlaid there.`;
}

/**
 * Genera una imagen por escena. Un fallo tras reintento reutiliza la imagen vecina
 * para no perder un video de 30 min por una sola escena.
 */
async function generarImagenesEscenas(escenas, guia, { apiImagen, modeloImagen, dir }, onProgreso) {
  fs.mkdirSync(dir, { recursive: true });
  const generar = prompt => apiImagen === 'google'
    ? llamarGoogleImagen(prompt, modeloImagen, '16:9')
    : llamarOpenAIImagen(prompt, modeloImagen, 'medium', '1536x1024');

  let hechos = 0;
  await ejecutarConLimite(escenas.map(e => async () => {
    const prompt = componerPrompt(guia, e);
    const ruta = path.join(dir, `escena-${String(e.n).padStart(3, '0')}.png`);
    for (let intento = 1; intento <= 2 && !e.imagen; intento++) {
      try {
        fs.writeFileSync(ruta, await generar(prompt));
        e.imagen = ruta;
      } catch (err) {
        console.error(`[escenasLargo] escena ${e.n} intento ${intento}: ${err.message}`);
      }
    }
    hechos++;
    if (onProgreso) onProgreso(hechos, escenas.length);
  }), CONCURRENCIA_IMAGENES);

  const conImagen = escenas.filter(e => e.imagen);
  if (!conImagen.length) throw new Error('No se pudo generar ninguna imagen de escena.');
  escenas.forEach((e, i) => {
    if (e.imagen) return;
    e.imagen = (escenas.slice(0, i).reverse().find(x => x.imagen) || conImagen[0]).imagen;
    e.imagenReutilizada = true;
  });
}

function tiempoAss(seg) {
  const cs = Math.max(0, Math.round(seg * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/** Escribe el archivo ASS con el texto clave de cada escena (caja semitransparente abajo al centro). */
function escribirAss(escenas, rutaAss, ancho = 1920, alto = 1080) {
  const eventos = escenas
    .filter(e => e.textoPantalla && e.fin - e.inicio > 1.5)
    .map(e => `Dialogue: 0,${tiempoAss(e.inicio + 0.4)},${tiempoAss(e.fin - 0.3)},Clave,,0,0,0,,{\\fad(300,300)}${e.textoPantalla}`);

  const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: ${ancho}
PlayResY: ${alto}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Clave,Arial,64,&H00FFFFFF,&H00FFFFFF,&H60000000,&H60000000,1,0,0,0,100,100,0,0,3,20,0,2,160,160,70,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${eventos.join('\n')}
`;
  fs.writeFileSync(rutaAss, ass, 'utf-8');
  return eventos.length;
}

module.exports = { agruparEscenas, dirigirArte, generarImagenesEscenas, escribirAss };
