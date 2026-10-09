// Whisper alignment with axios mocked: no paid API is called.
process.env.OPENAI_API_KEY = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');

let respuestaWhisper = () => ({ data: { words: [] } });
const peticiones = [];
axios.post = async (url, form) => {
  peticiones.push({ url, form });
  return respuestaWhisper();
};

const { alinearOraciones, alinearAudio, estimarPalabras, normalizarToken } = require('../services/alineacion');

// Whisper-like words: one every 0.5 s, 0.4 s long, optional gap after given indices
function palabras(texto, { inicio = 0, huecos = {} } = {}) {
  let t = inicio;
  return texto.split(/\s+/).map((w, i) => {
    const p = { word: w, start: t, end: t + 0.4 };
    t += 0.5 + (huecos[i] || 0);
    return p;
  });
}

test('normalizarToken ignores case, punctuation and accents', () => {
  assert.equal(normalizarToken('Über,'), 'uber');
  assert.equal(normalizarToken('«Straße»'), 'strasse');
  assert.equal(normalizarToken('E-Mail.'), 'email');
  assert.equal(normalizarToken('…'), '');
});

test('alinearOraciones maps exact transcripts to word times', () => {
  const oraciones = ['Hallo, ich bin Anna.', 'Wie geht es dir?'];
  const w = palabras('hallo ich bin anna wie geht es dir', { inicio: 1, huecos: { 3: 1 } });
  const r = alinearOraciones(oraciones, w, 10);
  assert.equal(r.confianza, 1);
  assert.equal(r.oraciones[0].inicio, 1);
  assert.ok(Math.abs(r.oraciones[0].fin - 2.9) < 1e-9);
  assert.ok(Math.abs(r.oraciones[1].inicio - 4) < 1e-9);
  assert.deepEqual(r.oraciones[0].palabras.map(p => p.texto), ['Hallo,', 'ich', 'bin', 'Anna.']);
});

test('alinearOraciones tolerates substitutions, missing and extra words (monotonic)', () => {
  const oraciones = ['Ich habe 3 Katzen zu Hause.', 'Sie heißen Mia und Leo.', 'Das ist toll.'];
  // "3" spoken as "drei", "zu" dropped, filler "äh" inserted, "heißen" transcribed "heissen"
  const w = palabras('ich habe drei katzen hause äh sie heissen mia und leo das ist toll');
  const r = alinearOraciones(oraciones, w, 20);
  assert.ok(r.confianza >= 0.8, `confianza ${r.confianza}`);
  const todas = r.oraciones.flatMap(o => o.palabras);
  assert.equal(todas.length, 14);
  for (let i = 1; i < todas.length; i++) assert.ok(todas[i].inicio >= todas[i - 1].fin - 1e-9);
  // "Sie" is the 7th Whisper word (index 6) -> 3.0 s
  assert.ok(Math.abs(r.oraciones[1].inicio - 3) < 1e-9);
  assert.ok(Math.abs(r.oraciones[2].inicio - 5.5) < 1e-9);
  // The missing "zu" is interpolated between "Katzen" and "Hause"
  const zu = r.oraciones[0].palabras[4];
  assert.equal(zu.texto, 'zu');
  assert.ok(zu.inicio >= 1.9 && zu.fin <= 2.0 + 1e-9);
});

test('alinearOraciones reports low confidence for an unrelated transcript', () => {
  const r = alinearOraciones(['Der Hund läuft schnell nach Hause.'], palabras('completely different english words here now'), 5);
  assert.ok(r.confianza < 0.6);
});

test('alinearOraciones keeps one entry per sentence even without tokens', () => {
  const r = alinearOraciones(['Hallo.', '…', 'Tschüss.'], palabras('hallo tschüss'), 5);
  assert.equal(r.oraciones.length, 3);
  assert.equal(r.oraciones[1].palabras.length, 0);
  assert.equal(r.oraciones[1].inicio, r.oraciones[0].fin);
});

test('estimarPalabras spreads the sentence duration by word length', () => {
  const p = estimarPalabras('ab abcd', 10, 13);
  assert.deepEqual(p.map(x => x.texto), ['ab', 'abcd']);
  assert.equal(p[0].inicio, 10);
  assert.ok(Math.abs(p[0].fin - 11) < 1e-9);
  assert.ok(Math.abs(p[1].fin - 13) < 1e-9);
});

test('alinearAudio sends verbose_json word request and returns aligned sentences', async () => {
  const ruta = path.join(os.tmpdir(), `alineacion-test-${process.pid}.flac`);
  fs.writeFileSync(ruta, Buffer.alloc(16));
  try {
    respuestaWhisper = () => ({ data: { words: palabras('guten morgen alle zusammen') } });
    const r = await alinearAudio(ruta, ['Guten Morgen,', 'alle zusammen!'], 'de', 3);
    assert.ok(r);
    assert.equal(r.oraciones[1].inicio, 1);
    assert.match(peticiones.at(-1).url, /audio\/transcriptions/);
    // form-data keeps text fields as strings in _streams (the file is a stream)
    const cuerpo = peticiones.at(-1).form._streams.filter(x => typeof x === 'string').join('');
    assert.match(cuerpo, /verbose_json/);
    assert.match(cuerpo, /timestamp_granularities\[\]/);
    assert.match(cuerpo, /whisper-1/);
  } finally {
    fs.unlinkSync(ruta);
  }
});

test('alinearAudio falls back (null) on Whisper error or low confidence', async () => {
  const ruta = path.join(os.tmpdir(), `alineacion-test2-${process.pid}.flac`);
  fs.writeFileSync(ruta, Buffer.alloc(16));
  try {
    respuestaWhisper = () => { const e = new Error('HTTP 500'); e.response = { status: 500, data: { error: 'x' } }; throw e; };
    assert.equal(await alinearAudio(ruta, ['Hallo.'], 'de', 1), null);
    respuestaWhisper = () => ({ data: { words: palabras('nothing matches here at all') } });
    assert.equal(await alinearAudio(ruta, ['Der Hund läuft schnell.'], 'de', 3), null);
  } finally {
    fs.unlinkSync(ruta);
  }
});
