const path = require('path');
const { normalizarToken } = require('./alineacion');

// Pure timeline builder for the Remotion long-video composition: every time is in seconds.

const FPS = 25;
const INTRO_SEG = 4.5;
const CAPITULO_SEG = 3;
const SEPARACION_TARJETAS = 0.4;
const MAX_CHARS_FRASE = 78;
const MIN_CHARS_CORTE = 34;
const PAUSA_CORTE_FRASE = 1.2;
const COLA_FRASE = 0.6;
const COINCIDENCIA_EJEMPLO = 0.85;
const COINCIDENCIA_QUIZ = 0.6;
const FRACCION_TABLA_RESPALDO = 0.35;
const CALLOUT_MAX_SEG = 8;

const ETIQUETAS = { ejemplo: 'Ejemplo', tabla: 'Tabla', puntos: 'Puntos clave', quiz: 'Pregunta', capitulo: 'Capítulo' };

/** Plain single-line text capped at `max` chars (rendered as React text nodes; this only bounds layout). */
function corto(valor, max) {
  const t = String(valor ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

const r2 = v => Math.round(v * 100) / 100;
const tokens = texto => String(texto || '').split(/\s+/).map(normalizarToken).filter(Boolean);

/** Fraction of `objetivo` tokens present in `texto` (order-insensitive). */
function coincidencia(objetivo, texto) {
  const obj = tokens(objetivo);
  if (!obj.length) return 0;
  const disponibles = new Set(tokens(texto));
  return obj.filter(t => disponibles.has(t)).length / obj.length;
}

function limitesSecciones(capitulos, duracion, nSecciones) {
  const n = Math.max(nSecciones, capitulos.length, 1);
  return Array.from({ length: n }, (_, s) => ({
    inicio: capitulos[s]?.inicio ?? (s === 0 ? 0 : duracion),
    fin: capitulos[s + 1]?.inicio ?? duracion,
  }));
}

/** Caption phrases: split each sentence by length, punctuation and pauses; never past the next phrase. */
function construirFrases(segmentos) {
  const frases = [];
  for (const seg of segmentos) {
    // Stray punctuation tokens (a closing quote split off by the sentence splitter) join the neighbouring word
    const palabras = [];
    for (const p of seg.palabras || []) {
      const texto = String(p?.texto || '').trim();
      if (!texto) continue;
      if (!/[\p{L}\p{N}]/u.test(texto) && palabras.length) palabras[palabras.length - 1] = { ...palabras[palabras.length - 1], texto: palabras[palabras.length - 1].texto + texto };
      else if (/[\p{L}\p{N}]/u.test(texto)) palabras.push({ ...p, texto });
    }
    let actual = null;
    const cerrar = () => { if (actual?.palabras.length) frases.push(actual); actual = null; };
    palabras.forEach((p, k) => {
      const texto = corto(p.texto, 40);
      const chars = actual ? actual.palabras.reduce((a, w) => a + w.t.length + 1, 0) : 0;
      const prev = actual?.palabras[actual.palabras.length - 1];
      if (actual && (chars + texto.length > MAX_CHARS_FRASE
        || (chars >= MIN_CHARS_CORTE && /[,;:–—]$/.test(prev.t))
        || p.inicio - prev.f > PAUSA_CORTE_FRASE)) cerrar();
      if (!actual) actual = { seccion: seg.seccion, voz: seg.voz || null, palabras: [] };
      actual.palabras.push({ t: texto, i: r2(p.inicio), f: r2(Math.max(p.inicio, p.fin)) });
      if (k === palabras.length - 1) cerrar();
    });
    cerrar();
  }
  frases.forEach((f, i) => {
    f.inicio = f.palabras[0].i;
    const siguiente = frases[i + 1]?.palabras[0].i ?? Infinity;
    f.fin = r2(Math.min(f.palabras[f.palabras.length - 1].f + COLA_FRASE, siguiente));
  });
  return frases.map(({ inicio, fin, voz, palabras }) => ({ inicio, fin, voz, palabras }));
}

/**
 * Places an interval of `dur` seconds as close as possible to `preferido` without overlapping
 * `ocupados` (cards and title-card windows), starting within [desde, hasta] and ending before `limite`.
 * Shrinks down to `durMin` if needed. Returns { inicio, fin } or null.
 */
function ubicar(ocupados, { preferido, desde, hasta, dur, durMin = dur, limite = Infinity }) {
  const choca = (a, b) => ocupados.some(o => a < o.fin + SEPARACION_TARJETAS && b > o.inicio - SEPARACION_TARJETAS);
  for (let d = dur; d >= durMin - 1e-9; d -= 0.5) {
    const candidatos = [preferido];
    for (const o of ocupados) candidatos.push(o.fin + SEPARACION_TARJETAS, o.inicio - SEPARACION_TARJETAS - d);
    const validos = candidatos
      .filter(c => c >= desde - 1e-9 && c <= hasta + 1e-9 && c + d <= limite + 1e-9 && !choca(c, c + d))
      .sort((a, b) => Math.abs(a - preferido) - Math.abs(b - preferido));
    if (validos.length) return { inicio: r2(validos[0]), fin: r2(validos[0] + d) };
  }
  return null;
}

/** Segment (or segment + next, for examples split across sentences) best matching `objetivo` above `umbral`. */
function buscarSegmento(segs, objetivo, umbral, minTokens = 2) {
  if (tokens(objetivo).length < minTokens) return null;
  for (let k = 0; k < segs.length; k++) {
    if (coincidencia(objetivo, segs[k].texto) >= umbral) return { inicio: segs[k].inicio, fin: segs[k].fin };
    if (segs[k + 1] && coincidencia(objetivo, `${segs[k].texto} ${segs[k + 1].texto}`) >= umbral
      && coincidencia(objetivo, segs[k + 1].texto) < umbral) {
      return { inicio: segs[k].inicio, fin: segs[k + 1].fin };
    }
  }
  return null;
}

/** First moment the table is talked about: a title/header word plus some cell words, or many cell words. */
function momentoTabla(segs, tabla) {
  const cabecera = new Set(tokens(`${tabla.titulo} ${tabla.columnas.join(' ')}`).filter(t => t.length >= 3));
  const celdas = new Set(tokens(tabla.filas.flat().join(' ')).filter(t => t.length >= 3 && !cabecera.has(t)));
  for (const s of segs) {
    const presentes = new Set(tokens(s.texto));
    const enCabecera = [...cabecera].filter(t => presentes.has(t)).length;
    const enCeldas = [...celdas].filter(t => presentes.has(t)).length;
    if ((enCabecera >= 1 && enCabecera + enCeldas >= 3) || enCeldas >= 5) return s.inicio;
  }
  return null;
}

function tarjetasSeccion(s, visual, lim, segs, ocupados, titulo) {
  const tarjetas = [];
  const poner = (tarjeta, opciones) => {
    const lugar = ubicar(ocupados, { limite: lim.fin - 0.3, ...opciones });
    if (!lugar) return null;
    const t = { ...tarjeta, seccion: s, ...lugar };
    ocupados.push(lugar);
    ocupados.sort((a, b) => a.inicio - b.inicio);
    tarjetas.push(t);
    return t;
  };

  // Spoken-anchored cards first (they only make sense when the line is heard), then the flexible ones.
  if (visual.quiz) {
    const m = buscarSegmento(segs, visual.quiz.pregunta, COINCIDENCIA_QUIZ, 3);
    if (m) {
      const t = poner({
        tipo: 'quiz', pregunta: corto(visual.quiz.pregunta, 140),
        opciones: visual.quiz.opciones.slice(0, 4).map(o => corto(o, 80)), correcta: visual.quiz.correcta,
      }, { preferido: m.inicio - 0.2, desde: m.inicio - 0.6, hasta: m.inicio + 1.5, dur: 10, durMin: 7 });
      if (t) t.revelar = r2(Math.min(t.fin - 2.5, Math.max(m.fin + 4, t.inicio + 4.5)));
    }
  }
  for (const ej of visual.ejemplos || []) {
    const m = buscarSegmento(segs, ej.texto, COINCIDENCIA_EJEMPLO);
    if (!m) continue;
    const dur = Math.min(9, Math.max(5.5, m.fin - m.inicio + 3.5));
    poner({ tipo: 'ejemplo', texto: corto(ej.texto, 140), traduccion: ej.traduccion ? corto(ej.traduccion, 140) : null },
      { preferido: m.inicio - 0.2, desde: m.inicio - 0.5, hasta: m.inicio + 1.5, dur, durMin: 4 });
  }
  if (visual.tabla) {
    const tabla = visual.tabla;
    const momento = momentoTabla(segs, tabla) ?? (lim.inicio + (lim.fin - lim.inicio) * FRACCION_TABLA_RESPALDO);
    const dur = Math.min(15, Math.max(10, 6 + 1.2 * tabla.filas.length));
    poner({
      tipo: 'tabla', titulo: corto(tabla.titulo, 60),
      columnas: tabla.columnas.slice(0, 5).map(c => corto(c, 30)),
      filas: tabla.filas.slice(0, 8).map(f => f.slice(0, 5).map(c => corto(c, 40))),
    }, { preferido: momento, desde: lim.inicio, hasta: lim.fin, dur, durMin: 8 });
  }
  if (visual.puntosClave?.length) {
    const puntos = visual.puntosClave.slice(0, 4).map(p => corto(p, 80));
    const dur = Math.min(12, Math.max(8, 5 + 1.5 * puntos.length));
    const preferido = lim.fin - 0.5 - dur;
    poner({ tipo: 'puntos', titulo: corto(titulo, 70), puntos },
      { preferido, desde: Math.max(lim.inicio, lim.inicio + (lim.fin - lim.inicio) * 0.5), hasta: preferido, dur, durMin: 6 });
  }
  return tarjetas;
}

/**
 * Props for the Remotion `Largo` composition.
 *
 * @param {object} p
 * @param {string}   p.titulo
 * @param {object[]} p.secciones  - [{ titulo, visual }] from guionLargo (visual already sanitized)
 * @param {object[]} p.capitulos  - [{ titulo, inicio }]
 * @param {object[]} p.segmentos  - [{ seccion, voz, texto, inicio, fin, palabras: [{ texto, inicio, fin }] }]
 * @param {object[]} p.escenas    - [{ inicio, fin, imagen, textoPantalla }]
 * @param {number}   p.duracion   - audio duration (s)
 */
function construirLineaTiempo({ titulo, secciones = [], capitulos = [], segmentos = [], escenas = [], duracion, fps = FPS, ancho = 1920, alto = 1080 }) {
  const dur = Math.max(0.1, duracion);
  const lims = limitesSecciones(capitulos, dur, secciones.length);

  const caps = lims.map((l, s) => ({ n: s + 1, titulo: corto(secciones[s]?.titulo ?? capitulos[s]?.titulo ?? '', 70), inicio: r2(l.inicio) }));
  const intro = { inicio: 0, fin: r2(Math.min(INTRO_SEG, dur)) };
  const titulos = [intro, ...caps.slice(1).map(c => ({ inicio: c.inicio, fin: r2(Math.min(dur, c.inicio + CAPITULO_SEG)) }))];

  const ocupados = titulos.map(t => ({ ...t }));
  const tarjetas = [];
  lims.forEach((lim, s) => {
    const visual = secciones[s]?.visual;
    if (!visual) return;
    const segs = segmentos.filter(g => g.seccion === s);
    tarjetas.push(...tarjetasSeccion(s, visual, lim, segs, ocupados, caps[s].titulo));
  });
  tarjetas.sort((a, b) => a.inicio - b.inicio);

  const callouts = [];
  escenas.forEach(e => {
    const texto = corto(e.textoPantalla, 60);
    if (!texto) return;
    let inicio = e.inicio + 0.5;
    for (const t of titulos) if (inicio < t.fin && e.fin > t.inicio && inicio >= t.inicio - 0.5) inicio = t.fin + 0.3;
    let fin = Math.min(e.fin - 0.3, inicio + CALLOUT_MAX_SEG, titulos.find(t => t.inicio > inicio)?.inicio ?? Infinity);
    // The scene's key phrase is often the quiz answer: never show it while a quiz is on screen
    const quiz = tarjetas.find(t => t.tipo === 'quiz' && t.inicio < fin && t.fin > inicio);
    if (quiz) fin = Math.min(fin, quiz.inicio - 0.3);
    if (fin - inicio < 2) return;
    // An example card already shows the same sentence in big type
    const repetida = tarjetas.some(t => t.tipo === 'ejemplo' && t.inicio < fin && t.fin > inicio && coincidencia(texto, t.texto) >= COINCIDENCIA_EJEMPLO);
    if (!repetida) callouts.push({ inicio: r2(inicio), fin: r2(fin), texto });
  });

  return {
    fps, ancho, alto,
    duracion: r2(dur),
    duracionFrames: Math.max(1, Math.ceil(dur * fps)),
    titulo: corto(titulo, 100),
    etiquetas: ETIQUETAS,
    dialogo: segmentos.some(s => s.voz),
    intro,
    capitulos: caps,
    escenas: escenas.map((e, i) => ({
      inicio: r2(i === 0 ? 0 : e.inicio), fin: r2(i === escenas.length - 1 ? dur : e.fin),
      archivo: e.imagen ? path.basename(e.imagen) : null, mov: i,
    })),
    frases: construirFrases(segmentos),
    callouts,
    tarjetas,
  };
}

module.exports = { construirLineaTiempo, construirFrases, ubicar, coincidencia, momentoTabla, buscarSegmento, corto };
