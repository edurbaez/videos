const { ts } = require('../utils/log');
const { MAX_SSE_CLIENTES } = require('../middleware/seguridad');

const EVENTOS_FINALES = new Set(['finalizado', 'pipeline_error']);
const RETENCION_TRAS_FINAL_MS = 10 * 60 * 1000;
// Safety net for jobs that never emit a final event (crash, hung provider)
const RETENCION_SIN_ACTIVIDAD_MS = 6 * 60 * 60 * 1000;
const MAX_EVENTOS_POR_ID = 2000;
const HEARTBEAT_MS = 20_000;
const BARRIDO_MS = 60_000;

/**
 * Creates a reusable SSE channel. Events are buffered per job id and replayed when a
 * client connects, so events emitted before the browser opens the EventSource are not lost.
 * Each event carries an incremental `id:` so an automatic reconnect (Last-Event-ID)
 * only receives what it missed.
 *
 * @param {string} nombre
 * @param {{ aliasError?: string[], log?: boolean }} [opciones]
 *   aliasError - legacy event names also emitted right after 'pipeline_error'
 */
function crearCanal(nombre, { aliasError = [], log = false } = {}) {
  const clientes = new Map(); // id -> Set<res>
  const buffers  = new Map(); // id -> { eventos: [{ seq, texto }], seq, ultimo, finAt }
  let conexiones = 0;

  const barrido = setInterval(() => {
    const ahora = Date.now();
    for (const [id, b] of buffers) {
      const expirado = b.finAt ? ahora - b.finAt > RETENCION_TRAS_FINAL_MS : ahora - b.ultimo > RETENCION_SIN_ACTIVIDAD_MS;
      if (expirado) buffers.delete(id);
    }
  }, BARRIDO_MS);
  barrido.unref();

  function escribir(id, evento, datos) {
    let b = buffers.get(id);
    if (!b) { b = { eventos: [], seq: 0, ultimo: 0, finAt: null }; buffers.set(id, b); }
    const seq = ++b.seq;
    const texto = `id: ${seq}\nevent: ${evento}\ndata: ${JSON.stringify(datos ?? {})}\n\n`;
    b.eventos.push({ seq, texto });
    if (b.eventos.length > MAX_EVENTOS_POR_ID) b.eventos.shift();
    b.ultimo = Date.now();
    if (EVENTOS_FINALES.has(evento) && !b.finAt) b.finAt = b.ultimo;

    for (const res of clientes.get(id) || []) {
      try { res.write(texto); } catch {}
    }
    if (log) console.log(`[${ts()}] SSE ${nombre} [${id}]: evento "${evento}"`);
  }

  function emit(id, evento, datos) {
    escribir(id, evento, datos);
    if (evento === 'pipeline_error') aliasError.forEach(alias => escribir(id, alias, datos));
  }

  function ruta(req, res) {
    const { id } = req.params;
    if (conexiones >= MAX_SSE_CLIENTES) {
      return res.status(429).json({ error: 'Demasiadas conexiones activas. Intenta más tarde.' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const ultimoVisto = parseInt(req.headers['last-event-id'], 10) || 0;
    for (const ev of buffers.get(id)?.eventos || []) {
      if (ev.seq > ultimoVisto) res.write(ev.texto);
    }

    if (!clientes.has(id)) clientes.set(id, new Set());
    clientes.get(id).add(res);
    conexiones++;

    const heartbeat = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch {} }, HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(heartbeat);
      conexiones--;
      const set = clientes.get(id);
      if (set) { set.delete(res); if (!set.size) clientes.delete(id); }
    });
  }

  return {
    ruta,
    emit,
    emisor: id => (evento, datos) => emit(id, evento, datos),
  };
}

module.exports = { crearCanal };
