/**
 * middleware/seguridad.js
 * Centraliza todas las medidas de seguridad del servidor.
 *
 * Uso en server.js:
 *   const seg = require('./middleware/seguridad');
 *   app.use(seg.limitarGlobal);
 *   app.use(seg.validarApiKey);
 */

const path = require('path');
const fs   = require('fs');
const rateLimit = require('express-rate-limit');

// ─────────────────────────────────────────────────────────────────────────────
// 1. AUTENTICACIÓN POR API KEY
// ─────────────────────────────────────────────────────────────────────────────
// Si API_KEY está definida en .env, se exige en todas las peticiones vía
// header "x-api-key" o query param "apiKey".
// Si no está definida, el middleware pasa sin bloquear (retrocompatibilidad).
function validarApiKey(req, res, next) {
  const claveEsperada = process.env.API_KEY;
  if (!claveEsperada) return next();

  const claveRecibida = req.headers['x-api-key'] || req.query.apiKey;
  if (!claveRecibida || claveRecibida !== claveEsperada) {
    return res.status(401).json({ error: 'No autorizado.' });
  }
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. RATE LIMITING
// ─────────────────────────────────────────────────────────────────────────────
// Límite global: 200 peticiones por IP cada 15 minutos.
const limitarGlobal = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones. Intenta de nuevo en 15 minutos.' },
});

// Límite estricto para /generar y /util/*: 10 por IP por minuto.
// Protege contra el abuso de APIs de pago (OpenAI, Google).
const limitarGenerar = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Límite de generaciones alcanzado. Espera 1 minuto.' },
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. VALIDACIÓN DE RUTA DE REFERENCIA (path traversal)
// ─────────────────────────────────────────────────────────────────────────────
// Garantiza que refImagePath esté DENTRO del directorio de referencias.
// Lanza Error si la ruta es inválida o el archivo no existe.
function validarRefImagePath(refImagePath, dirReferencias) {
  if (!refImagePath) return null;

  const resuelto = path.resolve(String(refImagePath));
  const dirBase  = path.resolve(dirReferencias);

  // El path resuelto debe comenzar con dirBase + separador
  if (!resuelto.startsWith(dirBase + path.sep)) {
    throw new Error('Ruta de imagen de referencia inválida.');
  }
  if (!fs.existsSync(resuelto)) {
    throw new Error('La imagen de referencia no existe en el servidor.');
  }
  return resuelto;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. SANITIZACIÓN DE TEMA (prompt injection básico)
// ─────────────────────────────────────────────────────────────────────────────
// Limita el tema a 500 caracteres y lo recorta. No hay caracteres prohibidos
// porque el texto es pasado a GPT como contenido de usuario (no como comando),
// pero una longitud máxima evita payloads excesivos.
const MAX_TEMA = 500;
function sanitizarTema(tema) {
  if (!tema || typeof tema !== 'string') return '';
  return tema.trim().slice(0, MAX_TEMA);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. VALIDACIÓN DE CANTIDAD
// ─────────────────────────────────────────────────────────────────────────────
const MAX_CANTIDAD = 20;
function validarCantidad(cantidad, max = MAX_CANTIDAD) {
  const n = parseInt(cantidad);
  if (isNaN(n) || n < 1) return 1;
  return Math.min(n, max);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. WHITELIST DE MODELOS (SSRF anti-injection en URLs de API)
// ─────────────────────────────────────────────────────────────────────────────
// El modelo se interpola en URLs de Vertex AI y OpenAI.
// Solo se permiten los modelos conocidos para evitar SSRF.
const MODELOS_OPENAI = new Set([
  'gpt-image-1',
  'gpt-image-1-mini',
  'dall-e-3',
  'dall-e-2',
]);
const MODELOS_GOOGLE = new Set([
  'imagen-3.0-generate-002',
  'imagen-3.0-generate-001',
  'imagegeneration@006',
  'imagen-4.0-generate-preview-06-06',
]);

function validarModelo(modelo, api) {
  if (!modelo) return; // Se usa el default del nicho, se valida más adelante
  const permitidos = api === 'google' ? MODELOS_GOOGLE : MODELOS_OPENAI;
  if (!permitidos.has(modelo)) {
    throw new Error(`Modelo "${modelo}" no permitido para la API "${api}". Modelos válidos: ${[...permitidos].join(', ')}.`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. VERIFICACIÓN DE MAGIC BYTES (imágenes subidas)
// ─────────────────────────────────────────────────────────────────────────────
// El Content-Type que envía el cliente es manipulable.
// Se leen los primeros 12 bytes del archivo para confirmar su tipo real.
// PNG:  89 50 4E 47
// JPEG: FF D8 FF
// WebP: 52 49 46 46 ?? ?? ?? ?? 57 45 42 50
// Si no coincide, se borra el archivo subido y se lanza un Error.
function verificarMagicBytes(filePath) {
  const buffer = Buffer.alloc(12);
  const fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, buffer, 0, 12, 0);
  fs.closeSync(fd);

  const esPNG  = buffer[0] === 0x89 && buffer[1] === 0x50 &&
                 buffer[2] === 0x4E && buffer[3] === 0x47;
  const esJPEG = buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
  const esWebP = buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
                 buffer.slice(8, 12).toString('ascii') === 'WEBP';

  if (!esPNG && !esJPEG && !esWebP) {
    try { fs.unlinkSync(filePath); } catch {}
    throw new Error('El archivo no es una imagen válida (PNG, JPEG o WebP).');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. LÍMITE DE CLIENTES SSE (anti-DoS)
// ─────────────────────────────────────────────────────────────────────────────
// Máximo de conexiones SSE simultáneas por canal.
// Evita que un atacante abra miles de conexiones y agote la memoria.
const MAX_SSE_CLIENTES = 50;

// ─────────────────────────────────────────────────────────────────────────────
// 9. NORMALIZACIÓN DE ERRORES (information disclosure)
// ─────────────────────────────────────────────────────────────────────────────
// En producción (NODE_ENV=production) los errores inesperados devuelven un
// mensaje genérico. En desarrollo se devuelve el mensaje real para depuración.
function mensajeError(err, esOperacional = false) {
  if (esOperacional) return err.message;
  if (process.env.NODE_ENV === 'production') return 'Error interno del servidor.';
  return err.message || 'Error desconocido.';
}

module.exports = {
  validarApiKey,
  limitarGlobal,
  limitarGenerar,
  validarRefImagePath,
  sanitizarTema,
  validarCantidad,
  validarModelo,
  verificarMagicBytes,
  MAX_SSE_CLIENTES,
  mensajeError,
};
