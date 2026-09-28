/** Runs async task factories with at most `limite` in flight at once. */
async function ejecutarConLimite(tareas, limite) {
  let siguiente = 0;
  const trabajadores = Array.from({ length: Math.min(limite, tareas.length) }, async () => {
    while (siguiente < tareas.length) {
      const i = siguiente++;
      await tareas[i]();
    }
  });
  await Promise.all(trabajadores);
}

const esperar = ms => new Promise(r => setTimeout(r, ms));

/**
 * Time-based rate limiter: each call to the returned function resolves no sooner than `msEntre`
 * after the previous call's slot. Slots are reserved synchronously, so concurrent workers and
 * retries share one timeline (image APIs enforce per-minute quotas).
 */
function crearLimitadorTiempo(msEntre, { ahora = Date.now, dormir = esperar } = {}) {
  let proximoInicio = 0;
  return async function turno() {
    const t = ahora();
    const inicio = Math.max(t, proximoInicio);
    proximoInicio = inicio + msEntre;
    if (inicio > t) await dormir(inicio - t);
  };
}

module.exports = { ejecutarConLimite, crearLimitadorTiempo, esperar };
