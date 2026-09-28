const { ts } = require('../utils/log');

const MAX_PIPELINES = Math.max(1, parseInt(process.env.MAX_PIPELINES, 10) || 1);

/**
 * In-memory FIFO queue that caps concurrent pipelines (image quota and FFmpeg CPU are shared).
 * Jobs waiting for a slot receive the SSE event 'en_cola' { posicion } (1 = next), re-emitted
 * whenever their position changes.
 */
function crearCola(max = MAX_PIPELINES) {
  let enCurso = 0;
  const espera = [];           // [{ id, emit, resolve }]
  const activos = new Map();   // id -> slots held

  function avisarPosiciones() {
    espera.forEach((e, i) => { try { e.emit('en_cola', { posicion: i + 1 }); } catch {} });
  }

  function tomar(id) {
    enCurso++;
    activos.set(id, (activos.get(id) || 0) + 1);
    let liberado = false;
    return () => {
      if (liberado) return;
      liberado = true;
      enCurso--;
      const n = activos.get(id) - 1;
      if (n > 0) activos.set(id, n); else activos.delete(id);
      const siguiente = espera.shift();
      if (siguiente) {
        avisarPosiciones();
        siguiente.resolve(tomar(siguiente.id));
      }
    };
  }

  /** Waits for a free slot. Resolves with an idempotent release function. */
  function adquirir(id, emit = () => {}) {
    if (enCurso < max && !espera.length) return Promise.resolve(tomar(id));
    return new Promise(resolve => {
      espera.push({ id, emit, resolve });
      console.log(`[${ts()}] Cola: ${id} en espera (posición ${espera.length}, en curso ${enCurso}/${max})`);
      emit('en_cola', { posicion: espera.length });
    });
  }

  /** Runs `tarea` inside a slot and always releases it. */
  async function ejecutar(id, emit, tarea) {
    const liberar = await adquirir(id, emit);
    try {
      return await tarea();
    } finally {
      liberar();
    }
  }

  /** Ids currently holding a slot or waiting for one (used by the output retention job). */
  function idsActivos() {
    return new Set([...activos.keys(), ...espera.map(e => e.id)]);
  }

  const estado = () => ({ max, enCurso, enEspera: espera.length });

  return { adquirir, ejecutar, idsActivos, estado };
}

module.exports = { crearCola, cola: crearCola() };
