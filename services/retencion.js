const fs = require('fs');
const path = require('path');
const { ts } = require('../utils/log');

const BASE = path.join(__dirname, '..', 'output');
const DIA_MS = 24 * 60 * 60 * 1000;
const PROTEGIDOS = [/^\./, /^_placeholder-/];

/** OUTPUT_RETENCION_DIAS as a positive integer, or 0 (retention disabled). */
function diasRetencion() {
  const n = parseInt(process.env.OUTPUT_RETENCION_DIAS, 10);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function dentroDe(base, ruta) {
  const rel = path.relative(base, ruta);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Newest mtime inside a directory tree (symlinks are not followed). */
function mtimeMasReciente(dir) {
  let max = fs.lstatSync(dir).mtimeMs;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const ruta = path.join(dir, e.name);
    max = Math.max(max, e.isDirectory() ? mtimeMasReciente(ruta) : fs.lstatSync(ruta).mtimeMs);
  }
  return max;
}

/**
 * Deletes job outputs older than `dias` days from each first-level folder of `base`
 * (output/audios, output/imagenes, output/largo, ...). A job directory (e.g. output/largo/<id>-img)
 * counts as old only if nothing inside it was modified recently.
 * Never touches: files directly in `base`, dotfiles (.gitkeep), `_placeholder-*`, symlinks,
 * anything outside `base`, or entries whose name contains an active job id.
 *
 * @returns {{ borrados: number, bytes: number, errores: number }}
 */
function limpiarOutput({ base = BASE, dias = diasRetencion(), idsActivos = new Set(), ahora = Date.now() } = {}) {
  const resultado = { borrados: 0, bytes: 0, errores: 0 };
  if (!dias || dias < 1 || !fs.existsSync(base)) return resultado;

  const limite = ahora - dias * DIA_MS;
  const baseReal = fs.realpathSync(base);
  const activos = [...idsActivos].filter(id => typeof id === 'string' && id.length >= 8);

  for (const carpeta of fs.readdirSync(baseReal, { withFileTypes: true })) {
    if (!carpeta.isDirectory()) continue;
    const dirCarpeta = path.join(baseReal, carpeta.name);

    for (const e of fs.readdirSync(dirCarpeta, { withFileTypes: true })) {
      if (PROTEGIDOS.some(re => re.test(e.name))) continue;
      if (activos.some(id => e.name.includes(id))) continue;
      const ruta = path.join(dirCarpeta, e.name);
      if (!dentroDe(baseReal, ruta)) continue;

      try {
        const st = fs.lstatSync(ruta);
        if (st.isSymbolicLink()) continue;
        if (st.isFile() && st.mtimeMs < limite) {
          fs.unlinkSync(ruta);
          resultado.borrados++;
          resultado.bytes += st.size;
        } else if (st.isDirectory() && mtimeMasReciente(ruta) < limite) {
          fs.rmSync(ruta, { recursive: true });
          resultado.borrados++;
        }
      } catch (err) {
        resultado.errores++;
        console.warn(`[${ts()}] Retención: no se pudo borrar ${e.name}: ${err.code || err.message}`);
      }
    }
  }
  return resultado;
}

module.exports = { limpiarOutput, diasRetencion };
