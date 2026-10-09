// Long-video script and OpenAI param mapping with axios mocked: no paid API is called.
process.env.OPENAI_API_KEY = 'test';
delete process.env.OPENAI_MODELO_GUION;
delete process.env.OPENAI_MODELO_LARGO_AUX;

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const llamadas = [];
let responder = () => 'ok';
axios.post = async (url, body, opciones) => {
  llamadas.push({ url, body, opciones });
  return { data: { choices: [{ message: { content: responder(body) }, finish_reason: 'stop' }] } };
};

const { chat, construirBody, esModeloRazonamiento } = require('../services/openai');
const guionLargo = require('../services/guionLargo');
const { generarGuionLargo, sanitizarVisual, separarEjemplos } = guionLargo;

test('openai: non-reasoning models keep max_tokens and temperature', () => {
  const body = construirBody({ model: 'gpt-4o', prompt: 'x', maxTokens: 500, temperature: 0.8, reasoningEffort: 'low' });
  assert.equal(body.max_tokens, 500);
  assert.equal(body.temperature, 0.8);
  assert.equal(body.max_completion_tokens, undefined);
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(construirBody({ model: 'gpt-4o-mini', prompt: 'x' }).max_tokens, undefined);
});

test('openai: reasoning models use max_completion_tokens + reserve, no temperature', () => {
  const body = construirBody({ model: 'gpt-6.1-sol', prompt: 'x', maxTokens: 1000, temperature: 0.7, reasoningEffort: 'low', json: true });
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.temperature, undefined);
  assert.equal(body.reasoning_effort, 'low');
  assert.ok(body.max_completion_tokens > 1000);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  const sinEsfuerzo = construirBody({ model: 'o3', prompt: 'x', maxTokens: 1000 });
  assert.equal(sinEsfuerzo.reasoning_effort, undefined);
  assert.ok(sinEsfuerzo.max_completion_tokens > body.max_completion_tokens, 'default (medium) reserves more than low');
});

test('openai: model family detection', () => {
  for (const m of ['gpt-5', 'gpt-5.4-mini', 'gpt-6.1-sol', 'gpt-6-luna', 'o3', 'o4-mini']) assert.ok(esModeloRazonamiento(m), m);
  for (const m of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-5-chat-latest']) assert.ok(!esModeloRazonamiento(m), m);
});

test('openai: longer default timeout only for reasoning models; empty content is an error', async () => {
  llamadas.length = 0;
  responder = () => 'hola';
  await chat({ model: 'gpt-4o', prompt: 'x' });
  await chat({ model: 'gpt-6.1-sol', prompt: 'x' });
  assert.equal(llamadas[0].opciones.timeout, 120_000);
  assert.ok(llamadas[1].opciones.timeout > 120_000);
  responder = () => null;
  await assert.rejects(chat({ model: 'gpt-6.1-sol', prompt: 'x' }), /vac/);
});

test('guionLargo.chat (aux) defaults to gpt-4o and respects OPENAI_MODELO_LARGO_AUX', async () => {
  llamadas.length = 0;
  responder = () => 'ok';
  await guionLargo.chat('x', { maxTokens: 100, temperature: 0.5 });
  assert.equal(llamadas[0].body.model, 'gpt-4o');
  assert.equal(llamadas[0].body.temperature, 0.5);
  process.env.OPENAI_MODELO_LARGO_AUX = 'gpt-4o-mini';
  try {
    await guionLargo.chat('x', { maxTokens: 100 });
    assert.equal(llamadas[1].body.model, 'gpt-4o-mini');
  } finally {
    delete process.env.OPENAI_MODELO_LARGO_AUX;
  }
});

test('sanitizarVisual: caps sizes, trims strings, invalid parts → null', () => {
  const largo = 'x'.repeat(500);
  const v = sanitizarVisual({
    puntosClave: ['  uno  ', '', 3, 'dos', 'tres', 'cuatro', 'cinco', { a: 1 }],
    ejemplos: ['Ich lerne.', { texto: ` ${largo} `, traduccion: 'Aprendo.' }, { texto: '' }, { traduccion: 'solo' }, 'a', 'b', 'c'],
    tabla: { titulo: 'T', columnas: ['a', 'b', 'c', 'd', 'e', 'f'], filas: [['1', '2', '3', '4', '5'], ['x']] },
    quiz: { pregunta: '¿?', opciones: ['a', 'b'], correcta: 2 },
  });
  assert.deepEqual(v.puntosClave, ['uno', '3', 'dos', 'tres']);
  assert.equal(v.ejemplos.length, 4);
  assert.deepEqual(v.ejemplos[0], { texto: 'Ich lerne.', traduccion: null });
  assert.ok(v.ejemplos[1].texto.length <= 140);
  assert.equal(v.tabla.columnas.length, 5);
  assert.deepEqual(v.tabla.filas, [['1', '2', '3', '4', '5']]);
  assert.equal(v.quiz, null, 'correcta out of range');

  const filas = Array.from({ length: 12 }, (_, i) => [String(i), 'y']);
  assert.equal(sanitizarVisual({ tabla: { columnas: ['a', 'b'], filas } }).tabla.filas.length, 8);
  assert.deepEqual(sanitizarVisual({ quiz: { pregunta: 'p', opciones: ['a', 'b', 'c'], correcta: 1 } }).quiz,
    { pregunta: 'p', opciones: ['a', 'b', 'c'], correcta: 1 });
  assert.equal(sanitizarVisual({ quiz: { pregunta: 'p', opciones: ['a', 'b'], correcta: '1' } }), null);
  assert.equal(sanitizarVisual({ quiz: { pregunta: 'p', opciones: ['a', 'b', 'c', 'd', 'e'], correcta: 0 } }), null);
  assert.equal(sanitizarVisual({ tabla: { columnas: [], filas: [[]] } }), null);
  assert.equal(sanitizarVisual(null), null);
  assert.equal(sanitizarVisual('x'), null);
  assert.equal(sanitizarVisual([]), null);
  assert.equal(sanitizarVisual({ puntosClave: ['a\nb\u0007c'] }).puntosClave[0], 'a b c');
});

test('separarEjemplos: strips the marker block and cleans list items', () => {
  const r = separarEjemplos('Texto hablado.\n\n###EJEMPLOS###\n- „Ich lerne.“\n2. "Du lernst."\n\n');
  assert.equal(r.texto, 'Texto hablado.');
  assert.deepEqual(r.ejemplos, ['Ich lerne.', 'Du lernst.']);
  assert.deepEqual(separarEjemplos('  Sin marca. '), { texto: 'Sin marca.', ejemplos: [] });
});

test('generarGuionLargo: script model, visual pass-through, used examples forwarded, retry kept', async () => {
  llamadas.length = 0;
  const esquema = {
    titulo: 'Lektion',
    secciones: [
      { titulo: 'Eins', contenido: ['a', 'b'], visual: { puntosClave: ['p1'], ejemplos: [{ texto: 'Ich versuche, zu lernen.', traduccion: 'Intento aprender.' }], tabla: null, quiz: null } },
      { titulo: 'Zwei', contenido: 'c', visual: { quiz: { pregunta: 'q', opciones: ['x', 'y'], correcta: 5 } } },
      { titulo: 'Drei', contenido: 'd', visual: 'basura' },
    ],
  };
  let seccion = 0;
  responder = body => {
    if (body.response_format) return JSON.stringify(esquema);
    seccion++;
    const palabras = seccion === 2 ? 10 : 190; // second call is too short → retry
    return `${'Wort '.repeat(palabras)}\n###EJEMPLOS###\nBeispiel ${seccion}.`;
  };

  const guion = await generarGuionLargo({ tema: 't', idioma: 'de', nivel: 'B1', minutos: 4, formato: 'monologo' });

  assert.ok(llamadas.every(l => l.body.model === 'gpt-6.1-sol'));
  assert.ok(llamadas.every(l => l.body.max_tokens === undefined && l.body.temperature === undefined));
  assert.equal(llamadas.length, 1 + 3 + 1, 'outline + 3 sections + 1 retry');
  assert.equal(guion.secciones.length, 3);
  assert.deepEqual(guion.secciones[0].visual.ejemplos, [{ texto: 'Ich versuche, zu lernen.', traduccion: 'Intento aprender.' }]);
  assert.equal(guion.secciones[1].visual, null);
  assert.equal(guion.secciones[2].visual, null);
  assert.ok(!guion.secciones[0].texto.includes('###EJEMPLOS###'));
  assert.equal(guion.secciones[0].palabras, 190);

  const promptSec1 = llamadas[1].body.messages[0].content;
  assert.match(promptSec1, /Ich versuche, zu lernen\./, 'outline examples go to the section prompt');
  assert.match(promptSec1, /hook/);
  const promptSec2 = llamadas[2].body.messages[0].content;
  assert.match(promptSec2, /already used in previous sections[^\n]*Ich versuche, zu lernen\.[^\n]*Beispiel 1\./);
  assert.ok(!/\{\{\w+\}\}/.test(promptSec2), 'no unrendered placeholders');
});

test('generarGuionLargo: OPENAI_MODELO_GUION overrides the script model', async () => {
  llamadas.length = 0;
  process.env.OPENAI_MODELO_GUION = 'gpt-4o';
  responder = body => (body.response_format
    ? JSON.stringify({ titulo: 'T', secciones: [{ titulo: 'a', contenido: 'x' }, { titulo: 'b', contenido: 'y' }] })
    : 'F: Hallo\nM: Hi\n' + 'Wort '.repeat(200));
  try {
    const g = await generarGuionLargo({ tema: 't', idioma: 'de', nivel: 'A2', minutos: 3, formato: 'dialogo' });
    assert.ok(llamadas.every(l => l.body.model === 'gpt-4o' && l.body.reasoning_effort === undefined));
    assert.ok(g.secciones[0].texto.split('\n').every(l => /^[FM]: /.test(l)));
  } finally {
    delete process.env.OPENAI_MODELO_GUION;
  }
});
