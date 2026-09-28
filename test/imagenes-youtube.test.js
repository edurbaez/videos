// Image generation and YouTube metadata with axios mocked: no paid API is called.
process.env.LARGO_SEGUNDOS_ENTRE_IMAGENES = '0';
process.env.OPENAI_API_KEY = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const llamadas = [];
let enVuelo = 0, maxEnVuelo = 0;
let fallarImagen = () => false;
const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');

axios.post = async (url, body) => {
  if (url.includes('/chat/completions')) {
    const prompt = body.messages[0].content;
    llamadas.push({ tipo: 'chat', prompt });
    if (body.response_format) {
      const escenas = Array.from({ length: 5 }, (_, i) => ({ numero: i + 1, prompt: `escena ${i + 1}` }));
      return { data: { choices: [{ message: { content: JSON.stringify({ personaje: 'p', escenas }) } }] } };
    }
    return { data: { choices: [{ message: { content: 'uno, dos, tres' } }] } };
  }
  const tipo = url.includes('/edits') ? 'edits' : 'generations';
  llamadas.push({ tipo });
  enVuelo++; maxEnVuelo = Math.max(maxEnVuelo, enVuelo);
  await new Promise(r => setTimeout(r, 15));
  enVuelo--;
  if (fallarImagen(llamadas.filter(l => l.tipo !== 'chat').length)) {
    const err = new Error('HTTP 400'); err.response = { status: 400, data: { error: 'x' } }; throw err;
  }
  return { data: { data: [{ b64_json: PNG }] } };
};

const { generarImagenes } = require('../services/imagenes');
const { generarMetadatosShorts } = require('../services/youtube');
const { cargarNicho } = require('../services/nichos');

function limpiar(rutas) {
  for (const r of rutas) try { fs.unlinkSync(r); } catch {}
}

test('generarImagenes (OpenAI): first image alone, rest in parallel with it as reference, order kept', async (t) => {
  llamadas.length = 0; maxEnVuelo = 0; fallarImagen = () => false;
  const id = 'test-' + uuidv4();
  const prompts = [];
  const rutas = await generarImagenes({
    guion: 'guion', cantidad: 5, id, nichoConfig: cargarNicho('historia'), modelo: 'gpt-image-2', api: 'openai',
    onPrompt: (n, p) => prompts.push([n, p]),
  });
  t.after(() => limpiar(rutas));

  assert.deepEqual(rutas.map(r => r.match(/-(\d+)\.png$/)[1]), ['1', '2', '3', '4', '5']);
  rutas.forEach(r => assert.ok(fs.existsSync(r)));
  const imagenes = llamadas.filter(l => l.tipo !== 'chat').map(l => l.tipo);
  assert.deepEqual(imagenes, ['generations', 'edits', 'edits', 'edits', 'edits']);
  assert.ok(maxEnVuelo >= 2 && maxEnVuelo <= 3, `concurrencia ${maxEnVuelo}`);
  assert.deepEqual(prompts.sort((a, b) => a[0] - b[0]).map(p => p[1]), ['escena 1', 'escena 2', 'escena 3', 'escena 4', 'escena 5']);
});

test('generarImagenes: a failed first image passes the anchor role to the next one; placeholder event fires', async (t) => {
  llamadas.length = 0; maxEnVuelo = 0;
  fallarImagen = n => n <= 2; // image 1 fails both attempts
  const id = 'test-' + uuidv4();
  const errores = [];
  const rutas = await generarImagenes({
    guion: 'guion', cantidad: 3, id, nichoConfig: cargarNicho('historia'), modelo: 'gpt-image-2',
    onErrorImagen: n => errores.push(n),
  }).catch(e => { if (/ffmpeg|ENOENT|spawn/i.test(e.message)) t.skip('FFmpeg no disponible para el placeholder'); throw e; });
  t.after(() => limpiar(rutas));
  assert.deepEqual(errores, [1]);
  assert.deepEqual(llamadas.filter(l => l.tipo !== 'chat').map(l => l.tipo), ['generations', 'generations', 'generations', 'edits']);
});

test('generarMetadatosShorts uses the niche prompt files (language, niche, no motivational tone)', async () => {
  llamadas.length = 0;
  const nicho = cargarNicho('historia');
  const meta = await generarMetadatosShorts('La caída de Roma', 'Guion de prueba', nicho);
  const prompts = llamadas.filter(l => l.tipo === 'chat').map(l => l.prompt);
  assert.equal(prompts.length, 3);
  for (const p of prompts) {
    assert.match(p, /La caída de Roma/);
    assert.doesNotMatch(p, /\{\{\w+\}\}/);
    assert.doesNotMatch(p, /motivational/i);
  }
  assert.ok(prompts.some(p => /Spanish/.test(p)));
  assert.match(meta.titulo, /#Shorts$/);
  assert.ok(meta.tags.includes('Shorts'));
});

test('generarMetadatosShorts falls back to the built-in prompts when the niche has none', async () => {
  llamadas.length = 0;
  await generarMetadatosShorts('Tema', 'Guion', { nombre: 'X', idioma: 'es', prompts: {} });
  const prompts = llamadas.filter(l => l.tipo === 'chat').map(l => l.prompt);
  assert.ok(prompts.some(p => /Engaging, motivational tone/.test(p)));
  assert.ok(prompts.every(p => /Niche: X/.test(p)));
});
