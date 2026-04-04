const fs = require('fs');
const path = require('path');

const RUTA_HISTORIAL = path.join(__dirname, '..', 'historial.json');
const MAX_ENTRADAS = 50;

/**
 * Lee el archivo historial.json y retorna el array de entradas.
 * Si el archivo no existe, retorna un array vacío.
 */
function leerHistorial() {
  try {
    if (!fs.existsSync(RUTA_HISTORIAL)) return [];
    const contenido = fs.readFileSync(RUTA_HISTORIAL, 'utf-8');
    return JSON.parse(contenido);
  } catch {
    return [];
  }
}

/**
 * Agrega una nueva entrada al inicio del historial y guarda el archivo.
 * Mantiene solo las últimas MAX_ENTRADAS entradas.
 * @param {Object} entrada - { id, tema, caption, guion, fecha, rutas, nicho?, parametros? }
 *   nicho      - id del nicho usado (ej. 'motivacion'). Opcional, default 'motivacion'.
 *   parametros - { voz, tts, modelo, api, estilo, escenario, cantidad }. Opcional.
 */
function guardarEntrada(entrada) {
  const historial = leerHistorial();
  historial.unshift(entrada);
  const recortado = historial.slice(0, MAX_ENTRADAS);
  fs.writeFileSync(RUTA_HISTORIAL, JSON.stringify(recortado, null, 2), 'utf-8');
}

module.exports = { leerHistorial, guardarEntrada };
