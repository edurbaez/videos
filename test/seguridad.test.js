const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const seg = require('../middleware/seguridad');

test('validarRefImagePath accepts files inside the references dir only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-'));
  const dentro = path.join(dir, 'ref-1.png');
  fs.writeFileSync(dentro, 'x');
  try {
    assert.equal(seg.validarRefImagePath(null, dir), null);
    assert.equal(seg.validarRefImagePath(dentro, dir), path.resolve(dentro));
    assert.throws(() => seg.validarRefImagePath(path.join(dir, '..', 'otro.png'), dir), /inválida/);
    assert.throws(() => seg.validarRefImagePath(dir, dir), /inválida/);
    assert.throws(() => seg.validarRefImagePath(dir + 'x' + path.sep + 'a.png', dir), /inválida/);
    assert.throws(() => seg.validarRefImagePath(path.join(dir, 'no-existe.png'), dir), /no existe/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validarFechaProgramada requires a valid date at least 15 min ahead', () => {
  assert.equal(seg.validarFechaProgramada(''), null);
  assert.equal(seg.validarFechaProgramada(undefined), null);
  assert.throws(() => seg.validarFechaProgramada('no-fecha'), /inválida/);
  assert.throws(() => seg.validarFechaProgramada(new Date(Date.now() + 5 * 60_000).toISOString()), /15 minutos/);
  const futura = new Date(Date.now() + 60 * 60_000);
  assert.equal(seg.validarFechaProgramada(futura.toISOString()), futura.toISOString());
});

test('validarQuality whitelists low|medium|high', () => {
  assert.equal(seg.validarQuality(undefined), 'medium');
  assert.equal(seg.validarQuality(''), 'medium');
  for (const q of ['low', 'medium', 'high']) assert.equal(seg.validarQuality(q), q);
  for (const q of ['ultra', 'HIGH', 1, {}]) assert.throws(() => seg.validarQuality(q), /no válida/);
});

test('claveCoincide compares in constant time and rejects empty/non-string', () => {
  assert.equal(seg.claveCoincide('abc', 'abc'), true);
  assert.equal(seg.claveCoincide('abd', 'abc'), false);
  assert.equal(seg.claveCoincide('abcd', 'abc'), false);
  assert.equal(seg.claveCoincide('', 'abc'), false);
  assert.equal(seg.claveCoincide(['abc'], 'abc'), false);
});

function llamar({ method = 'GET', path: p, headers = {}, query = {} }) {
  const req = { method, path: p, headers, query };
  let status = 200;
  let siguiente = false;
  const res = { status(c) { status = c; return this; }, json() { return this; } };
  seg.validarApiKey(req, res, () => { siguiente = true; });
  return { pasa: siguiente, status: siguiente ? 200 : status, req };
}

test('validarApiKey: header anywhere, query only on SSE, cookie only on GET /output and /youtube/auth', (t) => {
  const anterior = process.env.API_KEY;
  process.env.API_KEY = 'clave-test';
  t.after(() => { if (anterior === undefined) delete process.env.API_KEY; else process.env.API_KEY = anterior; });

  assert.equal(llamar({ path: '/nichos' }).status, 401);
  assert.equal(llamar({ path: '/nichos', headers: { 'x-api-key': 'mala' } }).status, 401);
  assert.equal(llamar({ path: '/nichos', headers: { 'x-api-key': 'clave-test' } }).pasa, true);
  assert.equal(llamar({ method: 'POST', path: '/generar', headers: { 'x-api-key': 'clave-test' } }).pasa, true);

  assert.equal(llamar({ path: '/nichos', query: { apiKey: 'clave-test' } }).status, 401);
  for (const p of ['/progreso/abc', '/util/imagenes-progress/abc', '/util/audio-progress/abc', '/curso/progreso/abc', '/largo/progreso/abc']) {
    const r = llamar({ path: p, query: { apiKey: 'clave-test' } });
    assert.equal(r.pasa, true, p);
    assert.equal('apiKey' in r.req.query, false, 'the key is stripped from req.query');
  }

  const cookie = { cookie: 'otra=1; apiKey=clave-test' };
  assert.equal(llamar({ path: '/output/videos/v.mp4', headers: cookie }).pasa, true);
  assert.equal(llamar({ path: '/youtube/auth', headers: cookie }).pasa, true);
  assert.equal(llamar({ path: '/nichos', headers: cookie }).status, 401);
  assert.equal(llamar({ method: 'POST', path: '/output/x', headers: cookie }).status, 401);

  assert.equal(llamar({ path: '/youtube/callback' }).pasa, true);
});

test('validarApiKey is a no-op without API_KEY', () => {
  const anterior = process.env.API_KEY;
  delete process.env.API_KEY;
  try {
    assert.equal(llamar({ path: '/nichos' }).pasa, true);
  } finally {
    if (anterior !== undefined) process.env.API_KEY = anterior;
  }
});
