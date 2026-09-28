const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { renderPrompt, joinHashtags, leerPromptArchivo } = require('../utils/prompts');
const { cargarNicho, listarNichos } = require('../services/nichos');

test('renderPrompt replaces placeholders and blanks missing ones', () => {
  assert.equal(renderPrompt('Hola {{a}} y {{b}}!', { a: 'X', b: 2 }), 'Hola X y 2!');
  assert.equal(renderPrompt('{{a}}|{{falta}}|{{nulo}}', { a: 0, nulo: null }), '0||');
});

test('renderPrompt does not re-expand placeholders inside values', () => {
  assert.equal(renderPrompt('{{a}}', { a: '{{b}}', b: 'NO' }), '{{b}}');
});

test('joinHashtags joins with spaces', () => {
  assert.equal(joinHashtags(['#a', '#b']), '#a #b');
  assert.equal(joinHashtags(), '');
});

test('leerPromptArchivo reads prompt files and rejects traversal', () => {
  assert.match(leerPromptArchivo('largo', 'esquema.txt'), /{{num_secciones}}/);
  assert.match(leerPromptArchivo('curso', 'youtube-titulo.txt'), /{{idioma_nombre}}/);
  assert.match(leerPromptArchivo('shorts', 'imagenes-bloque.txt'), /{{cantidad}}/);
  for (const [carpeta, archivo] of [['..', 'package.json'], ['largo', '../../package.json'], ['largo/..', 'x.txt'], ['largo', 'esquema'], ['', 'x.txt'], [null, 'x.txt']]) {
    assert.throws(() => leerPromptArchivo(carpeta, archivo), /Prompt inválido/);
  }
});

test('cargarNicho rejects invalid ids (path traversal)', () => {
  for (const id of ['../x', '..\\x', 'a/b', '', null, 'nicho.json', '%2e%2e']) {
    assert.throws(() => cargarNicho(id), /inválido/);
  }
  assert.throws(() => cargarNicho('no_existe_zz'), /no encontrado/);
});

test('cargarNicho returns an independent copy (cache must not be mutated by callers)', () => {
  const a = cargarNicho('motivacion');
  a.idioma = 'de';
  a.defaults.voz = 'otra';
  const b = cargarNicho('motivacion');
  assert.equal(b.idioma, 'es');
  assert.notEqual(b.defaults.voz, 'otra');
});

test('every niche has YouTube prompts, a numeric category and a language', () => {
  const nichos = listarNichos();
  assert.ok(nichos.length >= 9);
  for (const { id } of nichos) {
    const n = cargarNicho(id);
    assert.ok(n.prompts.youtubeTitulo && n.prompts.youtubeDescripcion && n.prompts.youtubeTags, `prompts youtube de ${id}`);
    assert.match(String(n.youtube.categoria), /^\d+$/, `categoria de ${id}`);
    assert.ok(n.idioma, `idioma de ${id}`);
    assert.ok(n.prompts.guionBorrador && n.prompts.storyboard, `prompts base de ${id}`);
  }
});

test('niche prompt files contain no hardcoded "motivational" outside motivacion', () => {
  const dir = path.join(__dirname, '..', 'nichos');
  for (const id of fs.readdirSync(dir)) {
    if (id === 'motivacion') continue;
    for (const f of ['prompt-youtube-titulo.txt', 'prompt-youtube-descripcion.txt', 'prompt-youtube-tags.txt']) {
      const ruta = path.join(dir, id, f);
      if (fs.existsSync(ruta)) assert.doesNotMatch(fs.readFileSync(ruta, 'utf-8'), /motivational/i, `${id}/${f}`);
    }
  }
});
