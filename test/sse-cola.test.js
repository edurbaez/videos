const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { crearCanal } = require('../lib/sse');
const { crearCola } = require('../lib/cola');
const { ejecutarConLimite, crearLimitadorTiempo } = require('../utils/concurrencia');

function conectar(canal, id, lastEventId) {
  const req = new EventEmitter();
  req.params = { id };
  req.headers = lastEventId ? { 'last-event-id': String(lastEventId) } : {};
  const res = {
    escrito: '',
    codigo: 200,
    setHeader() {},
    flushHeaders() {},
    write(t) { this.escrito += t; },
    status(c) { this.codigo = c; return this; },
    json() { return this; },
  };
  canal.ruta(req, res);
  return { req, res, cerrar: () => req.emit('close') };
}

const eventos = texto => [...texto.matchAll(/event: (\S+)/g)].map(m => m[1]);

test('sse: events emitted before connecting are replayed in order', () => {
  const canal = crearCanal('test');
  canal.emit('a', 'uno', { x: 1 });
  canal.emit('a', 'dos', {});
  const c = conectar(canal, 'a');
  assert.deepEqual(eventos(c.res.escrito), ['uno', 'dos']);
  canal.emit('a', 'tres', {});
  assert.deepEqual(eventos(c.res.escrito), ['uno', 'dos', 'tres']);
  assert.match(c.res.escrito, /id: 3\n/);
  c.cerrar();
});

test('sse: Last-Event-ID only replays missed events; ids are isolated', () => {
  const canal = crearCanal('test2');
  ['e1', 'e2', 'e3'].forEach(e => canal.emit('b', e, {}));
  canal.emit('otro', 'ajeno', {});
  const c = conectar(canal, 'b', 2);
  assert.deepEqual(eventos(c.res.escrito), ['e3']);
  c.cerrar();
});

test('sse: pipeline_error also emits the legacy aliases', () => {
  const canal = crearCanal('test3', { aliasError: ['error_pipeline'] });
  const emit = canal.emisor('c');
  emit('pipeline_error', { mensaje: 'x' });
  const c = conectar(canal, 'c');
  assert.deepEqual(eventos(c.res.escrito), ['pipeline_error', 'error_pipeline']);
  assert.match(c.res.escrito, /"mensaje":"x"/);
  c.cerrar();
});

test('cola: caps concurrency, reports queue positions and runs FIFO', async () => {
  const cola = crearCola(1);
  const orden = [];
  const posiciones = { b: [], c: [] };
  let liberarA;
  const a = cola.ejecutar('a', () => {}, () => new Promise(r => { orden.push('a'); liberarA = r; }));
  const b = cola.ejecutar('b', (ev, d) => posiciones.b.push(d.posicion), async () => { orden.push('b'); });
  const c = cola.ejecutar('c', (ev, d) => posiciones.c.push(d.posicion), async () => { orden.push('c'); });
  await new Promise(r => setImmediate(r));
  assert.deepEqual(cola.estado(), { max: 1, enCurso: 1, enEspera: 2 });
  assert.deepEqual([...cola.idsActivos()].sort(), ['a', 'b', 'c']);
  liberarA();
  await Promise.all([a, b, c]);
  assert.deepEqual(orden, ['a', 'b', 'c']);
  assert.deepEqual(posiciones.b, [1]);
  assert.deepEqual(posiciones.c, [2, 1]);
  assert.deepEqual(cola.estado(), { max: 1, enCurso: 0, enEspera: 0 });
});

test('cola: slot is released when the task throws, release is idempotent', async () => {
  const cola = crearCola(1);
  await assert.rejects(cola.ejecutar('x', () => {}, async () => { throw new Error('boom'); }), /boom/);
  const liberar = await cola.adquirir('y');
  liberar();
  liberar();
  assert.equal(cola.estado().enCurso, 0);
});

test('ejecutarConLimite never exceeds the limit and runs every task', async () => {
  let enVuelo = 0, maximo = 0;
  const hechas = [];
  const tareas = Array.from({ length: 7 }, (_, i) => async () => {
    enVuelo++; maximo = Math.max(maximo, enVuelo);
    await new Promise(r => setTimeout(r, 5));
    hechas.push(i);
    enVuelo--;
  });
  await ejecutarConLimite(tareas, 3);
  assert.equal(maximo, 3);
  assert.deepEqual(hechas.sort(), [0, 1, 2, 3, 4, 5, 6]);
});

test('crearLimitadorTiempo spaces slots even for concurrent callers', async () => {
  let reloj = 1000;
  const esperas = [];
  const turno = crearLimitadorTiempo(500, { ahora: () => reloj, dormir: async ms => { esperas.push(ms); } });
  await Promise.all([turno(), turno(), turno()]);
  assert.deepEqual(esperas, [500, 1000]);
  reloj = 5000;
  await turno();
  assert.deepEqual(esperas, [500, 1000]);
});
