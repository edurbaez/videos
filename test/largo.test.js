const test = require('node:test');
const assert = require('node:assert/strict');
const { agruparEscenas } = require('../services/escenasLargo');
const { trocearTexto, segmentarSeccion } = require('../services/audioLargo');

const seg = (seccion, inicio, fin, texto = 'x.') => ({ seccion, voz: null, texto, inicio, fin });

test('agruparEscenas covers the whole audio without gaps and never crosses sections', () => {
  const segmentos = [];
  for (let i = 0; i < 20; i++) segmentos.push(seg(i < 10 ? 0 : 1, i * 5, i * 5 + 5));
  const escenas = agruparEscenas(segmentos, 20, 100);

  assert.equal(escenas[0].inicio, 0);
  assert.equal(escenas.at(-1).fin, 100);
  for (let i = 1; i < escenas.length; i++) assert.equal(escenas[i].inicio, escenas[i - 1].fin);
  escenas.forEach((e, i) => assert.equal(e.n, i + 1));
  // Section boundary at t=50 must start a scene
  assert.ok(escenas.some(e => e.inicio === 50 && e.seccion === 1));
});

test('agruparEscenas merges a too-short last scene of a section into the previous one', () => {
  const segmentos = [seg(0, 0, 10), seg(0, 10, 20), seg(0, 20, 22), seg(1, 22, 40)];
  const escenas = agruparEscenas(segmentos, 20, 40);
  assert.deepEqual(escenas.map(e => [e.seccion, e.inicio, e.fin]), [[0, 0, 22], [1, 22, 40]]);
});

test('agruparEscenas prefixes the speaker in dialogues', () => {
  const escenas = agruparEscenas([{ seccion: 0, voz: 'F', texto: 'Hola.', inicio: 0, fin: 2 }], 30, 2);
  assert.equal(escenas[0].texto, 'F: Hola.');
});

test('trocearTexto keeps chunks <= 4000 bytes and loses no text', () => {
  const oracion = 'Esta es una oración de prueba con acentos áéíóú. ';
  const texto = oracion.repeat(300);
  const trozos = trocearTexto(texto);
  assert.ok(trozos.length > 1);
  for (const t of trozos) assert.ok(Buffer.byteLength(t, 'utf8') <= 4000);
  assert.equal(trozos.join(' ').replace(/\s+/g, ' ').trim(), texto.replace(/\s+/g, ' ').trim());
});

test('trocearTexto splits a giant sentence without punctuation by words', () => {
  const texto = 'palabra '.repeat(1200).trim();
  const trozos = trocearTexto(texto);
  assert.ok(trozos.length >= 2);
  for (const t of trozos) assert.ok(Buffer.byteLength(t, 'utf8') <= 4000);
  assert.equal(trozos.join(' ').split(/\s+/).length, 1200);
});

test('trocearTexto returns a single chunk for short text', () => {
  assert.deepEqual(trocearTexto('Hola. Adiós.'), ['Hola. Adiós.']);
});

test('segmentarSeccion distributes time by sentence length and rescales to the section duration', () => {
  const piezas = [
    { voz: null, texto: 'Uno dos. Tres cuatro cinco seis.', duracion: 6, pausa: 1 },
    { voz: null, texto: 'Final.', duracion: 2, pausa: 1 },
  ];
  const segs = segmentarSeccion(piezas, 3, 100, 20); // raw 10 s -> scale 2
  assert.equal(segs.length, 3);
  assert.ok(segs.every(s => s.seccion === 3));
  assert.equal(segs[0].inicio, 100);
  assert.ok(segs[1].fin - segs[1].inicio > segs[0].fin - segs[0].inicio);
  // pieza 1 speech = 12 s; pause 2 s; pieza 2 starts at 114 and lasts 4 s
  assert.ok(Math.abs(segs[1].fin - 112) < 1e-9);
  assert.ok(Math.abs(segs[2].inicio - 114) < 1e-9);
  assert.ok(Math.abs(segs[2].fin - 118) < 1e-9);
});
