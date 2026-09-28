const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { leerHistorial, guardarEntrada, recortarPorTipo } = require('../utils/historial');

function rutaTmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'historial.json');
}

test('old entries without tipo are read as shorts', (t) => {
  const ruta = rutaTmp(t);
  fs.writeFileSync(ruta, JSON.stringify([{ id: 'viejo', rutas: { video: '/v.mp4' } }]));
  assert.deepEqual(leerHistorial({ ruta }).map(e => [e.id, e.tipo]), [['viejo', 'short']]);
  assert.equal(leerHistorial({ ruta, tipo: 'curso' }).length, 0);
});

test('guardarEntrada stores the type and filters by it, newest first', (t) => {
  const ruta = rutaTmp(t);
  guardarEntrada({ id: 's1' }, { ruta });
  guardarEntrada({ tipo: 'curso', id: 'c1' }, { ruta });
  guardarEntrada({ tipo: 'largo', id: 'l1' }, { ruta });
  guardarEntrada({ tipo: 'raro', id: 's2' }, { ruta });
  assert.deepEqual(leerHistorial({ ruta }).map(e => e.id), ['s2', 'l1', 'c1', 's1']);
  assert.deepEqual(leerHistorial({ ruta, tipo: 'short' }).map(e => e.id), ['s2', 's1']);
  assert.deepEqual(leerHistorial({ ruta, tipo: 'largo' }).map(e => e.id), ['l1']);
});

test('corrupt or non-array file reads as empty', (t) => {
  const ruta = rutaTmp(t);
  fs.writeFileSync(ruta, '{roto');
  assert.deepEqual(leerHistorial({ ruta }), []);
  fs.writeFileSync(ruta, '{"a":1}');
  assert.deepEqual(leerHistorial({ ruta }), []);
});

test('recortarPorTipo caps each type separately', () => {
  const entradas = [
    ...Array.from({ length: 5 }, (_, i) => ({ tipo: 'curso', id: `c${i}` })),
    { id: 's0' },
    { tipo: 'short', id: 's1' },
  ];
  const r = recortarPorTipo(entradas, 2);
  assert.deepEqual(r.map(e => e.id), ['c0', 'c1', 's0', 's1']);
});
