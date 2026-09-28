const fs = require('fs');
const path = require('path');
const { escribirJsonAtomico } = require('./archivos');

const RUTA_HISTORIAL = path.join(__dirname, '..', 'historial.json');
const MAX_POR_TIPO = 50;
const TIPOS = ['short', 'curso', 'largo'];

/** Old entries have no `tipo`: they are shorts. */
const tipoDe = entrada => (TIPOS.includes(entrada?.tipo) ? entrada.tipo : 'short');

/**
 * Lee historial.json (todas las generaciones: shorts, curso y largo), más recientes primero.
 * Si el archivo no existe o está corrupto, retorna un array vacío.
 * @param {{ tipo?: 'short'|'curso'|'largo', ruta?: string }} [opciones] - tipo filtra por tipo de generación
 */
function leerHistorial({ tipo, ruta = RUTA_HISTORIAL } = {}) {
  let historial;
  try {
    if (!fs.existsSync(ruta)) return [];
    historial = JSON.parse(fs.readFileSync(ruta, 'utf-8'));
  } catch {
    return [];
  }
  if (!Array.isArray(historial)) return [];
  const normalizado = historial.map(e => ({ ...e, tipo: tipoDe(e) }));
  return tipo ? normalizado.filter(e => e.tipo === tipo) : normalizado;
}

/** Keeps the newest `max` entries of each type (a burst of courses never evicts the shorts). */
function recortarPorTipo(historial, max = MAX_POR_TIPO) {
  const cuenta = {};
  return historial.filter(e => {
    const t = tipoDe(e);
    cuenta[t] = (cuenta[t] || 0) + 1;
    return cuenta[t] <= max;
  });
}

/**
 * Agrega una nueva entrada al inicio del historial y guarda el archivo (escritura atómica).
 * @param {Object} entrada - { tipo?, id, tema, fecha, rutas, ... }
 *   tipo       - 'short' (default) | 'curso' | 'largo'
 *   short:  { caption, guion, nicho, nombreNicho, parametros, rutas: { audio, imagenes, video }, imagenesPlaceholder?, youtubeUrl? }
 *   curso:  { numero, idioma, nivel, modo, rutas: { audio, txt, video? }, youtubeUrl? }
 *   largo:  { titulo, idioma, nivel, formato, modo, rutas: { txt, audio?, video? }, youtubeUrl? }
 */
function guardarEntrada(entrada, { ruta = RUTA_HISTORIAL } = {}) {
  const historial = leerHistorial({ ruta });
  historial.unshift({ ...entrada, tipo: tipoDe(entrada) });
  escribirJsonAtomico(ruta, recortarPorTipo(historial));
}

module.exports = { leerHistorial, guardarEntrada, recortarPorTipo, TIPOS };
