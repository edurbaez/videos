const test = require('node:test');
const assert = require('node:assert/strict');
const {
  construirLineaTiempo, construirFrases, ubicar, coincidencia, momentoTabla, buscarSegmento,
} = require('../services/lineaTiempoLargo');
const { estimarPalabras } = require('../services/alineacion');

const seg = (seccion, texto, inicio, fin, voz = null) => ({ seccion, voz, texto, inicio, fin, palabras: estimarPalabras(texto, inicio, fin) });

function caso() {
  const segmentos = [
    seg(0, 'Willkommen zur Lektion über Wechselpräpositionen.', 0, 4),
    seg(0, 'Heute lernen wir, wann man den Akkusativ braucht.', 4, 9),
    seg(0, 'Ich lege das Buch auf den Tisch.', 9, 12),
    seg(0, 'Hier zeigt die Bewegung den Akkusativ.', 12, 16),
    seg(0, 'Das Buch liegt auf dem Tisch.', 16, 19),
    seg(0, 'Jetzt ist es der Dativ, denn es gibt keine Bewegung.', 19, 25),
    seg(0, 'Ergänze: Ich hänge das Bild an … Wand.', 25, 29),
    seg(0, 'Richtig ist an die Wand.', 29, 33),
    ...Array.from({ length: 10 }, (_, k) => seg(0, `Satz Nummer ${k} ohne besonderen Inhalt hier.`, 33 + k * 3, 36 + k * 3)),
    seg(1, 'Im zweiten Teil geht es um Wohin und Wo.', 63, 68),
    seg(1, 'Die Frage Wohin verlangt den Akkusativ, die Frage Wo den Dativ.', 68, 75),
    ...Array.from({ length: 10 }, (_, k) => seg(1, `Weitere Erklärung ${k} für die Zuschauer.`, 75 + k * 4, 79 + k * 4)),
  ];
  const secciones = [
    {
      titulo: 'Bewegung oder Position?',
      visual: {
        puntosClave: ['Bewegung → Akkusativ', 'Position → Dativ'],
        ejemplos: [
          { texto: 'Ich lege das Buch auf den Tisch.', traduccion: 'Pongo el libro sobre la mesa.' },
          { texto: 'Das Buch liegt auf dem Tisch.', traduccion: null },
          { texto: 'Dieser Satz kommt im Audio nicht vor.', traduccion: 'No se dice.' },
        ],
        tabla: null,
        quiz: { pregunta: 'Completa: Ich hänge das Bild an ___ Wand.', opciones: ['die', 'der'], correcta: 0 },
      },
    },
    {
      titulo: 'Wohin oder Wo?',
      visual: {
        puntosClave: ['Wohin? → Akkusativ', 'Wo? → Dativ', 'Gleiche Präposition'],
        ejemplos: [],
        tabla: { titulo: 'Wohin oder Wo?', columnas: ['Frage', 'Kasus'], filas: [['Wohin?', 'Akkusativ'], ['Wo?', 'Dativ']] },
        quiz: { pregunta: '¿Qué caso usa wohin?', opciones: ['Akkusativ', 'Dativ'], correcta: 0 },
      },
    },
  ];
  const escenas = [
    { inicio: 0, fin: 30, imagen: 'C:\\x\\img\\escena-001.png', textoPantalla: 'Wechselpräpositionen' },
    { inicio: 30, fin: 63, imagen: 'C:\\x\\img\\escena-002.png', textoPantalla: '' },
    { inicio: 63, fin: 115, imagen: 'C:\\x\\img\\escena-003.png', textoPantalla: 'Wohin? Wo?' },
  ];
  return construirLineaTiempo({
    titulo: 'Wechselpräpositionen', secciones, segmentos, escenas, duracion: 115,
    capitulos: [{ titulo: 'Bewegung oder Position?', inicio: 0 }, { titulo: 'Wohin oder Wo?', inicio: 63 }],
  });
}

test('coincidencia ignores case, punctuation, quotes and diacritics', () => {
  assert.equal(coincidencia('„Ich versuche, Deutsch zu lernen.“', 'ich versuche deutsch zu lernen'), 1);
  assert.equal(coincidencia('Müller', 'MULLER'), 1);
  assert.ok(coincidencia('Ich versuche, Deutsch zu lernen.', '„Ich versuche, Deutsch lernen.“') < 0.85);
});

test('buscarSegmento finds an example split over two sentences but not a partial one', () => {
  const segs = [seg(0, 'Beispiel eins:', 0, 1), seg(0, 'Er sagt: Ich komme.', 1, 3), seg(0, 'Morgen um acht.', 3, 5)];
  assert.deepEqual(buscarSegmento(segs, 'Ich komme morgen um acht.', 0.85), { inicio: 1, fin: 5 });
  assert.equal(buscarSegmento(segs, 'Wir gehen ins Kino.', 0.85), null);
});

test('ubicar avoids occupied intervals, prefers the closest slot and shrinks when needed', () => {
  const ocupados = [{ inicio: 10, fin: 20 }];
  assert.deepEqual(ubicar(ocupados, { preferido: 0, desde: 0, hasta: 50, dur: 5 }), { inicio: 0, fin: 5 });
  assert.deepEqual(ubicar(ocupados, { preferido: 16, desde: 0, hasta: 50, dur: 5 }), { inicio: 20.4, fin: 25.4 });
  assert.deepEqual(ubicar(ocupados, { preferido: 12, desde: 0, hasta: 50, dur: 5 }), { inicio: 4.6, fin: 9.6 });
  assert.equal(ubicar(ocupados, { preferido: 12, desde: 11, hasta: 13, dur: 5 }), null);
  const corto = ubicar([{ inicio: 0, fin: 4 }, { inicio: 10, fin: 20 }], { preferido: 4.4, desde: 4, hasta: 6, dur: 8, durMin: 4 });
  assert.ok(corto && corto.fin <= 9.6 && corto.fin - corto.inicio >= 4);
});

test('momentoTabla needs a header word plus content, else null', () => {
  const tabla = { titulo: 'Wohin oder Wo?', columnas: ['Frage', 'Kasus'], filas: [['Wohin?', 'Akkusativ'], ['Wo?', 'Dativ']] };
  const segs = [seg(1, 'Hallo zusammen.', 0, 2), seg(1, 'Die Frage Wohin verlangt den Akkusativ.', 2, 6)];
  assert.equal(momentoTabla(segs, tabla), 2);
  assert.equal(momentoTabla([seg(1, 'Hallo zusammen.', 0, 2)], tabla), null);
});

test('construirLineaTiempo: cards anchored to speech, inside their section, never overlapping', () => {
  const p = caso();
  const tipos = p.tarjetas.map(t => `${t.seccion}:${t.tipo}`);
  assert.ok(tipos.includes('0:quiz'), 'spoken quiz is shown');
  assert.ok(!tipos.includes('1:quiz'), 'unspoken quiz is skipped');
  assert.equal(p.tarjetas.filter(t => t.tipo === 'ejemplo').length, 2, 'unspoken example is skipped');
  assert.ok(tipos.includes('1:tabla') && tipos.includes('0:puntos') && tipos.includes('1:puntos'));

  const ej = p.tarjetas.find(t => t.tipo === 'ejemplo' && t.texto.startsWith('Ich lege'));
  assert.ok(ej.inicio >= 8.5 && ej.inicio <= 10.5);
  const quiz = p.tarjetas.find(t => t.tipo === 'quiz');
  assert.ok(quiz.inicio >= 24.4 && quiz.inicio <= 26.5 && quiz.revelar > quiz.inicio && quiz.revelar < quiz.fin);
  const tabla = p.tarjetas.find(t => t.tipo === 'tabla');
  assert.ok(tabla.inicio >= 66 && tabla.inicio <= 69, `table at first mention after chapter card (${tabla.inicio})`);
  const recap = p.tarjetas.find(t => t.tipo === 'puntos' && t.seccion === 0);
  assert.ok(recap.fin <= 63 && recap.fin >= 55, 'recap near the end of its section');

  const orden = [...p.tarjetas].sort((a, b) => a.inicio - b.inicio);
  for (let i = 1; i < orden.length; i++) assert.ok(orden[i].inicio >= orden[i - 1].fin, 'no overlap');
  for (const t of p.tarjetas) {
    assert.ok(t.inicio >= p.intro.fin || t.inicio >= 0);
    assert.ok(!(t.inicio < 66 && t.fin > 63), 'no card during the chapter card');
    assert.ok(t.inicio >= p.intro.fin, 'no card during the intro');
  }
});

test('construirLineaTiempo: frames, chapters, scenes and callouts', () => {
  const p = caso();
  assert.equal(p.duracionFrames, 115 * 25);
  assert.deepEqual(p.capitulos.map(c => [c.n, c.inicio]), [[1, 0], [2, 63]]);
  assert.deepEqual(p.escenas.map(e => e.archivo), ['escena-001.png', 'escena-002.png', 'escena-003.png']);
  assert.equal(p.escenas[2].fin, 115);
  // First callout starts after the intro card, second after the chapter card
  assert.ok(p.callouts[0].inicio >= p.intro.fin);
  assert.ok(p.callouts[1].inicio >= 66);
  assert.ok(p.callouts.every(c => c.fin - c.inicio <= 8));
});

test('construirLineaTiempo: a callout never shows during a quiz (it may give the answer away)', () => {
  const segmentos = [
    seg(0, 'Einleitung zum Thema heute.', 0, 6),
    seg(0, 'Ergänze: Das Buch liegt oben … dem Tisch.', 6, 10),
    seg(0, 'Richtig: auf dem Tisch.', 10, 14),
    seg(0, 'Noch ein Satz zum Schluss hier.', 14, 40),
  ];
  const p = construirLineaTiempo({
    titulo: 'T', duracion: 40, capitulos: [{ titulo: 'S', inicio: 0 }], segmentos,
    secciones: [{ titulo: 'S', visual: { puntosClave: [], ejemplos: [], tabla: null, quiz: { pregunta: 'Completa: Das Buch liegt oben ___ dem Tisch.', opciones: ['auf', 'an'], correcta: 0 } } }],
    escenas: [{ inicio: 0, fin: 40, imagen: 'a.png', textoPantalla: 'Das Buch liegt auf dem Tisch.' }],
  });
  const quiz = p.tarjetas.find(t => t.tipo === 'quiz');
  assert.ok(quiz);
  for (const c of p.callouts) assert.ok(c.fin <= quiz.inicio || c.inicio >= quiz.fin);
});

test('construirFrases: max length, punctuation breaks, no overlap, speaker kept', () => {
  const largo = 'Das ist ein sehr langer Satz, der eindeutig mehr als achtundsiebzig Zeichen enthält und deshalb geteilt werden muss, damit er gut lesbar bleibt.';
  const frases = construirFrases([seg(0, largo, 0, 10, 'F'), seg(0, 'Kurz.', 10.2, 11, 'M')]);
  assert.ok(frases.length >= 3);
  for (const f of frases) {
    assert.ok(f.palabras.map(w => w.t).join(' ').length <= 78);
    assert.ok(f.fin > f.inicio);
  }
  for (let i = 1; i < frases.length; i++) assert.ok(frases[i].inicio >= frases[i - 1].fin);
  assert.equal(frases[0].voz, 'F');
  assert.equal(frases[frases.length - 1].voz, 'M');
});

test('construirLineaTiempo caps untrusted text lengths', () => {
  const p = construirLineaTiempo({
    titulo: 'T'.repeat(500), duracion: 30,
    secciones: [{ titulo: 'S'.repeat(300), visual: { puntosClave: ['x'.repeat(400)], ejemplos: [], tabla: null, quiz: null } }],
    capitulos: [{ titulo: 'S', inicio: 0 }],
    segmentos: [seg(0, 'Wort '.repeat(5), 0, 30)],
    escenas: [{ inicio: 0, fin: 30, imagen: 'a.png', textoPantalla: 'y'.repeat(300) }],
  });
  assert.ok(p.titulo.length <= 100);
  assert.ok(p.capitulos[0].titulo.length <= 70);
  assert.ok(p.tarjetas[0].puntos[0].length <= 80);
  assert.ok(p.callouts[0].texto.length <= 60);
});
