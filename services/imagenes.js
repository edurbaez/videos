const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const TIMEOUT_IMAGEN_MS = 180_000;

const { rutaImagen, urlImagen, DIR_IMAGENES } = require('../utils/archivos');
const { ts } = require('../utils/log');
const { chat } = require('./openai');
const { obtenerAccessToken } = require('./googleAuth');
const { ESTILOS_ES, ESTILOS_EN, ESCENARIOS_EN } = require('../utils/estilos');
const { generarStoryboard } = require('./storyboard');
const { renderPrompt, leerPromptArchivo } = require('../utils/prompts');
const { ejecutarConLimite, crearLimitadorTiempo, esperar } = require('../utils/concurrencia');
const { MS_ENTRE_IMAGENES } = require('../utils/constantes');
const { validarModelo, MODELO_IMAGEN_OPENAI_DEFAULT } = require('../middleware/seguridad');

// Galería en memoria: persiste mientras el servidor esté corriendo (FIFO acotada)
const MAX_GALERIA = 200;
const galeria = [];

function agregarAGaleria(entrada) {
  galeria.push({ ...entrada, fecha: new Date().toISOString() });
  if (galeria.length > MAX_GALERIA) galeria.splice(0, galeria.length - MAX_GALERIA);
}

/**
 * Devuelve una copia de la galería completa.
 * @returns {{ id: string, numero: number, ruta: string, urlPublica: string, prompt: string, fecha: string }[]}
 */
function obtenerGaleria() {
  return [...galeria];
}

/**
 * Genera un prompt visual en inglés para la imagen N usando GPT-4o-mini.
 *
 * @param {string} guion  - Texto del guion
 * @param {number} n      - Número de la imagen actual (1-based)
 * @param {number} total  - Total de imágenes a generar
 * @returns {string} - Prompt visual en inglés
 */
async function generarPromptVisual(guion, n, total, estilo = 'cinematico', escenario = 'ninguno', nichoConfig) {
  const estiloEN    = ESTILOS_EN[estilo]    || ESTILOS_EN.cinematico;
  const escenarioEN = ESCENARIOS_EN[escenario] || '';

  const content = renderPrompt(nichoConfig.prompts.imagenes, {
    guion,
    n,
    total,
    nombre_nicho:     nichoConfig.nombre,
    estilo_narrativo: nichoConfig.imagenes.estiloNarrativo,
    tipo_escenas:     nichoConfig.imagenes.tipoEscenas,
    estilo_visual_en: estiloEN,
    escenario_en:     escenarioEN,
  });

  return chat({ model: 'gpt-4o-mini', prompt: content, temperature: 0.9 });
}

/**
 * Llama a OpenAI Images con modelo configurable (ver MODELOS_OPENAI en middleware/seguridad.js).
 * Size portrait 9:16 → 1024x1536 (gpt-image no soporta 1024x1792 de DALL-E 3)
 * Quality: low | medium | high
 *
 * @param {string} promptVisual - Prompt en inglés
 * @param {string} modelo       - Modelo a usar (default: gpt-image-2)
 * @param {string} quality      - Calidad: low | medium | high (default: medium)
 * @returns {Buffer} - Buffer de la imagen PNG
 */
async function llamarOpenAIImagen(promptVisual, modelo = MODELO_IMAGEN_OPENAI_DEFAULT, quality = 'medium', size = '1024x1536') {
  validarModelo(modelo, 'openai');
  let resp;
  try {
    resp = await axios.post(
      'https://api.openai.com/v1/images/generations',
      {
        model: modelo,
        prompt: promptVisual,
        n: 1,
        size,
        quality,
        output_format: 'png',
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: TIMEOUT_IMAGEN_MS,
      }
    );
  } catch (err) {
    const detalle = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`OpenAI (${modelo}) HTTP ${err.response?.status}: ${detalle}`);
  }
  const b64 = resp.data.data[0]?.b64_json;
  if (!b64) throw new Error('OpenAI no devolvió imagen en la respuesta.');
  console.log(`[OpenAI Imagen] ${modelo} (${quality}) generada correctamente.`);
  return Buffer.from(b64, 'base64');
}

/**
 * Llama a OpenAI Images Edits (/v1/images/edits) con una imagen de referencia.
 * Úsalo cuando se quiera mantener consistencia de estilo/personaje entre imágenes.
 *
 * @param {string} promptVisual  - Prompt en inglés
 * @param {string} refImagePath  - Ruta local de la imagen de referencia
 * @param {string} modelo        - Modelo (ver MODELOS_OPENAI)
 * @param {string} quality       - Calidad: low | medium | high
 * @returns {Buffer} - Buffer de la imagen PNG
 */
async function llamarOpenAIImagenEdits(promptVisual, refImagePath, modelo = MODELO_IMAGEN_OPENAI_DEFAULT, quality = 'medium') {
  validarModelo(modelo, 'openai');
  const form = new FormData();
  const ext = path.extname(refImagePath).toLowerCase();
  const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.png': 'image/png' };
  const mime = mimeMap[ext] || 'image/png';

  form.append('image[]', fs.createReadStream(refImagePath), { filename: `referencia${ext}`, contentType: mime });
  form.append('prompt', promptVisual);
  form.append('model', modelo);
  form.append('n', '1');
  form.append('size', '1024x1536');
  form.append('quality', quality);
  form.append('output_format', 'png');

  let resp;
  try {
    resp = await axios.post(
      'https://api.openai.com/v1/images/edits',
      form,
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          ...form.getHeaders(),
        },
        maxBodyLength: Infinity,
        timeout: TIMEOUT_IMAGEN_MS,
      }
    );
  } catch (err) {
    const detalle = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`OpenAI Edits (${modelo}) HTTP ${err.response?.status}: ${detalle}`);
  }

  const b64 = resp.data.data[0]?.b64_json;
  if (!b64) throw new Error('OpenAI Edits no devolvió imagen en la respuesta.');
  console.log(`[OpenAI Edits] ${modelo} (${quality}) con referencia generada correctamente.`);
  return Buffer.from(b64, 'base64');
}

/**
 * Llama a Google Imagen via Vertex AI con service account.
 * Endpoint: https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google/models/{modelo}:predict
 */
async function llamarGoogleImagen(promptVisual, modelo = 'imagen-3.0-generate-002', aspectRatio = '9:16') {
  validarModelo(modelo, 'google');
  const project  = process.env.GOOGLE_PROJECT_ID;
  const location = process.env.GOOGLE_LOCATION || 'us-central1';
  const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${modelo}:predict`;

  const token = await obtenerAccessToken();

  let resp;
  try {
    resp = await axios.post(
      endpoint,
      {
        instances: [{ prompt: promptVisual }],
        parameters: {
          sampleCount: 1,
          aspectRatio,
          safetyFilterLevel: 'block_few',
          personGeneration: 'allow_adult',
        },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: TIMEOUT_IMAGEN_MS,
      }
    );
  } catch (err) {
    const detalle = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`Google Imagen Vertex (${modelo}) HTTP ${err.response?.status}: ${detalle}`);
  }

  const b64 = resp.data.predictions?.[0]?.bytesBase64Encoded;
  if (!b64) {
    const filtradas = resp.data.predictions?.length === 0 || resp.data.raiFilteredCount > 0;
    const razon = filtradas ? 'filtro de seguridad activado' : 'sin imagen en la respuesta';
    console.warn(`[Google Imagen] ${razon}. Respuesta: ${JSON.stringify(resp.data).slice(0, 200)}`);
    throw new Error(`Google Imagen: ${razon}`);
  }
  return Buffer.from(b64, 'base64');
}

/**
 * Genera N imágenes usando un prompt directo del usuario (sin pasar por GPT).
 * Soporta api='google' o api='openai'.
 */
async function generarImagenesDirectas(prompt, cantidad, id, modelo, api, onCadaImagen, refImagePath = null, quality = 'medium') {
  const rutas = [];
  const prompts = Array.isArray(prompt) ? prompt : null;

  for (let i = 0; i < cantidad; i++) {
    const n = i + 1;
    const promptActual = prompts ? (prompts[i] || prompts[prompts.length - 1]) : prompt;
    const ruta = rutaImagen(id, n);
    const urlPublica = urlImagen(id, n);

    const modoRef = refImagePath && api !== 'google' ? ' +ref' : '';
    console.log(`[${ts()}] Imagen directa ${n}/${cantidad}: api=${api} modelo=${modelo}${modoRef}...`);

    let guardada = false;
    for (let intento = 1; intento <= 2; intento++) {
      try {
        let buffer;
        if (api === 'google') {
          buffer = await llamarGoogleImagen(promptActual, modelo);
        } else if (refImagePath) {
          buffer = await llamarOpenAIImagenEdits(promptActual, refImagePath, modelo, quality);
        } else {
          buffer = await llamarOpenAIImagen(promptActual, modelo, quality);
        }
        fs.writeFileSync(ruta, buffer);
        agregarAGaleria({ id, numero: n, ruta, urlPublica, prompt: promptActual });
        guardada = true;
        break;
      } catch (err) {
        console.warn(`[${ts()}] Imagen ${n}/${cantidad}: intento ${intento} falló — ${err.message}`);
      }
    }

    if (!guardada) {
      console.error(`[${ts()}] Imagen ${n}/${cantidad}: usando placeholder negro.`);
      await crearPlaceholder(ruta);
      agregarAGaleria({ id, numero: n, ruta, urlPublica, prompt: null });
    }

    rutas.push(ruta);
    if (onCadaImagen) await onCadaImagen(n, ruta, urlPublica);
  }

  return rutas;
}

const RUTA_PLACEHOLDER_BASE = path.join(DIR_IMAGENES, '_placeholder-1080x1920.png');
let placeholderBase = null;

/** Renders the black 1080x1920 PNG once (async FFmpeg) and memoizes it. */
function obtenerPlaceholderBase() {
  if (!placeholderBase) {
    placeholderBase = (async () => {
      if (fs.existsSync(RUTA_PLACEHOLDER_BASE)) return RUTA_PLACEHOLDER_BASE;
      const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
      const tmp = `${RUTA_PLACEHOLDER_BASE}.${process.pid}.tmp.png`;
      await promisify(execFile)(ffmpeg, ['-f', 'lavfi', '-i', 'color=black:size=1080x1920:rate=1', '-frames:v', '1', '-y', tmp]);
      await fs.promises.rename(tmp, RUTA_PLACEHOLDER_BASE);
      return RUTA_PLACEHOLDER_BASE;
    })().catch(err => { placeholderBase = null; throw err; });
  }
  return placeholderBase;
}

/**
 * Copia el placeholder negro de 1080x1920 a `ruta`.
 * Se usa como fallback cuando la API de imágenes falla dos veces seguidas.
 */
async function crearPlaceholder(ruta) {
  try {
    await fs.promises.copyFile(await obtenerPlaceholderBase(), ruta);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // Base was deleted from disk (e.g. output cleanup) after being memoized: regenerate once
    placeholderBase = null;
    await fs.promises.copyFile(await obtenerPlaceholderBase(), ruta);
  }
}

const CONCURRENCIA_IMAGENES = { openai: 3, google: 2 };
const PAUSA_REINTENTO_429_MS = 35_000;
const PAUSA_REINTENTO_MS = 4000;

/**
 * Genera todas las imágenes de un short.
 * Para cada imagen: genera prompt (o usa el del storyboard) → llama a la API de imágenes → guarda PNG.
 * Si la API falla, reintenta una vez. Si falla de nuevo, usa placeholder negro.
 *
 * Paralelismo: concurrencia limitada (CONCURRENCIA_IMAGENES) más un limitador por tiempo
 * (MS_ENTRE_IMAGENES) compartido por workers y reintentos. El resultado mantiene el orden 1..N.
 *
 * Consistencia de personaje: sin `refImagePath` (referencia manual) y con OpenAI, se genera en serie
 * hasta que una imagen sale bien; esa queda como referencia automática (`/v1/images/edits`) y el
 * resto se genera en paralelo con ella.
 *
 * @param {object} o
 * @param {string} o.guion
 * @param {number} o.cantidad
 * @param {string} o.id              - UUID de la generación
 * @param {object} o.nichoConfig     - cargarNicho() result
 * @param {string} o.modelo
 * @param {'openai'|'google'} [o.api='openai']
 * @param {string} [o.estilo='cinematico']
 * @param {string} [o.escenario='ninguno']
 * @param {string|null} [o.refImagePath=null]
 * @param {string} [o.quality='medium']
 * @param {(n: number, prompt: string) => void} [o.onPrompt]
 * @param {(escenas: object[]) => void} [o.onStoryboard]
 * @param {(n: number, mensaje: string) => void} [o.onErrorImagen]
 * @returns {Promise<string[]>} rutas absolutas en orden
 */
async function generarImagenes({
  guion, cantidad, id, nichoConfig, modelo, api = 'openai', estilo = 'cinematico', escenario = 'ninguno',
  refImagePath = null, quality = 'medium', onPrompt = null, onStoryboard = null, onErrorImagen = null,
}) {
  console.log(`[${ts()}] Imagenes: generando ${cantidad} imágenes para id ${id} (api=${api} modelo=${modelo} estilo=${estilo} escenario=${escenario} nicho=${nichoConfig.id})...`);

  // Storyboard when there is more than one image so the prompts form a narrative sequence
  let storyboardPrompts = null;
  if (cantidad > 1) {
    console.log(`[${ts()}] Imagenes: generando storyboard para ${cantidad} escenas...`);
    try {
      const escenas = await generarStoryboard(guion, cantidad, estilo, escenario, nichoConfig);
      if (onStoryboard) onStoryboard(escenas);
      storyboardPrompts = escenas.map(e => e.prompt);
      console.log(`[${ts()}] Imagenes: storyboard listo con ${escenas.length} escenas.`);
    } catch (err) {
      console.warn(`[${ts()}] Imagenes: error generando storyboard (${err.message}), usando prompts individuales.`);
    }
  }

  const rutas = Array.from({ length: cantidad }, (_, i) => rutaImagen(id, i + 1));
  const turno = crearLimitadorTiempo(MS_ENTRE_IMAGENES);
  let refAuto = null;

  const usarPlaceholder = async (n, mensaje) => {
    console.error(`[${ts()}] Imagen ${n}/${cantidad}: usando placeholder negro.`);
    await crearPlaceholder(rutas[n - 1]);
    agregarAGaleria({ id, numero: n, ruta: rutas[n - 1], urlPublica: urlImagen(id, n), prompt: null });
    if (onErrorImagen) onErrorImagen(n, mensaje);
  };

  /** Generates image n; resolves true if a real image was saved. */
  async function generarUna(n) {
    const ruta = rutas[n - 1];
    const refActual = api === 'google' ? null : (refImagePath || refAuto);

    let promptVisual;
    if (storyboardPrompts) {
      promptVisual = storyboardPrompts[n - 1];
    } else {
      try {
        promptVisual = await generarPromptVisual(guion, n, cantidad, estilo, escenario, nichoConfig);
      } catch (err) {
        console.error(`[${ts()}] Imagen ${n}/${cantidad}: error generando prompt: ${err.message}`);
        await usarPlaceholder(n, err.message);
        return false;
      }
    }
    if (onPrompt) onPrompt(n, promptVisual);
    console.log(`[${ts()}] Imagen ${n}/${cantidad}: llamando ${api}/${modelo}${refActual ? ' (con referencia para consistencia)' : ''}...`);

    let ultimoError = '';
    for (let intento = 1; intento <= 2; intento++) {
      try {
        await turno();
        let buffer;
        if (api === 'google') {
          buffer = await llamarGoogleImagen(promptVisual, modelo);
        } else if (refActual) {
          buffer = await llamarOpenAIImagenEdits(promptVisual, refActual, modelo, quality);
        } else {
          buffer = await llamarOpenAIImagen(promptVisual, modelo, quality);
        }
        await fs.promises.writeFile(ruta, buffer);
        console.log(`[${ts()}] Imagen ${n}/${cantidad}: guardada (intento ${intento})`);
        agregarAGaleria({ id, numero: n, ruta, urlPublica: urlImagen(id, n), prompt: promptVisual });
        return true;
      } catch (err) {
        ultimoError = err.message;
        const es429 = err.message.includes('429') || err.message.includes('RESOURCE_EXHAUSTED');
        const pausa = es429 ? PAUSA_REINTENTO_429_MS : PAUSA_REINTENTO_MS;
        console.warn(`[${ts()}] Imagen ${n}/${cantidad}: intento ${intento} falló — ${err.message}`);
        if (intento < 2) {
          console.log(`[${ts()}] Imagen ${n}/${cantidad}: esperando ${pausa / 1000}s antes de reintentar...`);
          await esperar(pausa);
        }
      }
    }
    await usarPlaceholder(n, ultimoError);
    return false;
  }

  let n = 1;
  if (api !== 'google' && !refImagePath) {
    // Serial until one succeeds: that image anchors the rest (edits) for character consistency
    for (; n <= cantidad && !refAuto; n++) {
      if (await generarUna(n)) refAuto = rutas[n - 1];
    }
  }
  const restantes = Array.from({ length: cantidad - n + 1 }, (_, i) => n + i);
  await ejecutarConLimite(restantes.map(k => () => generarUna(k)), CONCURRENCIA_IMAGENES[api] || 2);

  console.log(`[${ts()}] Imagenes: todas las imágenes generadas.`);
  return rutas;
}

/**
 * Genera todos los prompts visuales en una sola llamada a GPT.
 * Template: nichos/<id>/prompt-imagenes-bloque.txt if present, else prompts/shorts/imagenes-bloque.txt.
 * Devuelve un array de N strings, uno por fotograma.
 */
async function generarTodosPrompts(guion, cantidad, estilo = 'cinematico', escenario = 'ninguno', nichoConfig) {
  const estiloEN    = ESTILOS_EN[estilo]    || ESTILOS_EN.cinematico;
  const escenarioEN = ESCENARIOS_EN[escenario] || '';

  const plantilla = nichoConfig.prompts?.imagenesBloque || leerPromptArchivo('shorts', 'imagenes-bloque.txt');
  const content = renderPrompt(plantilla, {
    guion,
    cantidad,
    nombre_nicho:     nichoConfig.nombre,
    arco_narrativo:   nichoConfig.imagenes?.arcoNarrativo || '',
    estilo_visual_en: estiloEN,
    escenario_regla:  escenarioEN ? `El entorno/ambiente de TODOS los prompts DEBE incluir: ${escenarioEN}. ` : '',
  }).trim();

  const texto = await chat({ model: 'gpt-4o-mini', prompt: content, temperature: 0.9 });
  const prompts = texto.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 10);

  const generico = `Create an image of a scene from a ${nichoConfig.nombre} video, ${estiloEN}.`;
  while (prompts.length < cantidad) {
    prompts.push(prompts[prompts.length - 1] || generico);
  }
  return prompts.slice(0, cantidad);
}

/**
 * Genera imágenes una por una (secuencial, solo OpenAI).
 * Llama onCadaImagen(n, ruta, urlPublica) después de guardar cada una.
 *
 * @param {object} o - { guion, cantidad, id, nichoConfig, modelo?, quality?, estilo?, escenario?,
 *                       onCadaImagen?, onPrompt?, onStoryboard? }
 */
async function generarImagenesSecuencial({
  guion, cantidad, id, nichoConfig, modelo = MODELO_IMAGEN_OPENAI_DEFAULT, quality = 'medium',
  estilo = 'cinematico', escenario = 'ninguno', onCadaImagen = null, onPrompt = null, onStoryboard = null,
}) {
  let prompts;
  if (cantidad > 1) {
    console.log(`[${ts()}] Imagenes: generando storyboard para ${cantidad} escenas (estilo=${estilo} escenario=${escenario} nicho=${nichoConfig.id})...`);
    try {
      const escenas = await generarStoryboard(guion, cantidad, estilo, escenario, nichoConfig);
      if (onStoryboard) onStoryboard(escenas);
      prompts = escenas.map(e => e.prompt);
      console.log(`[${ts()}] Imagenes: storyboard listo. Procesando secuencialmente...`);
    } catch (err) {
      console.warn(`[${ts()}] Imagenes: error en storyboard (${err.message}), usando prompts en bloque.`);
      prompts = await generarTodosPrompts(guion, cantidad, estilo, escenario, nichoConfig);
    }
  } else {
    console.log(`[${ts()}] Imagenes: generando 1 prompt (sin storyboard)...`);
    prompts = await generarTodosPrompts(guion, 1, estilo, escenario, nichoConfig);
  }
  console.log(`[${ts()}] Imagenes: ${prompts.length} prompts listos. Procesando secuencialmente...`);

  const rutas = [];

  for (let i = 0; i < cantidad; i++) {
    const n = i + 1;
    const ruta = rutaImagen(id, n);
    const urlPublica = urlImagen(id, n);
    const prompt = prompts[i];

    if (onPrompt) onPrompt(n, prompt);
    console.log(`[${ts()}] Imagen ${n}/${cantidad}: llamando OpenAI (${modelo}, ${quality})...`);

    let guardada = false;

    for (let intento = 1; intento <= 2; intento++) {
      try {
        const buffer = await llamarOpenAIImagen(prompt, modelo, quality);
        fs.writeFileSync(ruta, buffer);
        agregarAGaleria({ id, numero: n, ruta, urlPublica, prompt });
        console.log(`[${ts()}] Imagen ${n}/${cantidad}: guardada (intento ${intento}).`);
        guardada = true;
        break;
      } catch (err) {
        console.warn(`[${ts()}] Imagen ${n}/${cantidad}: intento ${intento} falló — ${err.message}`);
      }
    }

    if (!guardada) {
      console.error(`[${ts()}] Imagen ${n}/${cantidad}: usando placeholder negro.`);
      await crearPlaceholder(ruta);
      agregarAGaleria({ id, numero: n, ruta, urlPublica, prompt: null });
    }

    rutas.push(ruta);
    if (onCadaImagen) await onCadaImagen(n, ruta, urlPublica);
  }

  console.log(`[${ts()}] Imagenes: todas procesadas.`);
  return rutas;
}

module.exports = { generarImagenes, generarImagenesSecuencial, generarImagenesDirectas, obtenerGaleria, llamarOpenAIImagen, llamarGoogleImagen };
