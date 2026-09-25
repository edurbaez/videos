const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const path = require('path');
const { execSync } = require('child_process');
const { GoogleAuth } = require('google-auth-library');
require('dotenv').config();

const { rutaImagen } = require('../utils/archivos');
const { ESTILOS_ES, ESTILOS_EN, ESCENARIOS_EN } = require('../utils/estilos');
const { generarStoryboard } = require('./storyboard');
const { renderPrompt } = require('../utils/prompts');
const { validarModelo } = require('../middleware/seguridad');

// Galería en memoria: persiste mientras el servidor esté corriendo
const galeria = [];

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

  const resp = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content }],
      temperature: 0.9,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );
  return resp.data.choices[0].message.content.trim();
}

/**
 * Analiza un fragmento de guion y devuelve un esquema concreto (en inglés) de qué
 * información visual específica debe aparecer en la infografía que lo acompaña:
 * palabras/frases clave, diagrama o relación a ilustrar, íconos, datos o pasos.
 * Se usa como input del prompt de imagen para que el modelo no tenga que "adivinar".
 *
 * @param {string} segmento - Fragmento del guion correspondiente a esta imagen
 * @param {string} tema     - Tema general del curso/video
 * @param {string} nivel    - Nivel (ej. A1-C2)
 * @param {string} langName - Idioma en el que debe estar el texto de la imagen
 * @returns {string} - Esquema de contenido visual en inglés
 */
async function generarEsquemaInfografia(segmento, tema, nivel, langName) {
  const content = `You are an educational infographic content planner. Analyze this script excerpt from a language-course video and decide EXACTLY what visual information the accompanying infographic must contain.

Course topic: "${tema}"
Level: ${nivel}
Script excerpt: "${segmento}"

Return a short, concrete list (3-5 items max) of the specific visual elements to include: exact key words/phrases to display (written in ${langName}), what diagram or relationship to illustrate, what icons to use, what data or steps to number. Be literal and specific to this excerpt, not generic. Answer only with the list, in English except for the ${langName} words/phrases to display, ready to be inserted into an image-generation prompt.`;

  const resp = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content }],
      temperature: 0.5,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );
  return resp.data.choices[0].message.content.trim();
}

/**
 * Llama a OpenAI Images (gpt-image-1, gpt-image-1-mini) con modelo configurable.
 * Modelos soportados: gpt-image-1, gpt-image-1-mini
 * Size portrait 9:16 → 1024x1536 (gpt-image-1 no soporta 1024x1792 de DALL-E 3)
 * Quality: low | medium | high
 *
 * @param {string} promptVisual - Prompt en inglés
 * @param {string} modelo       - Modelo a usar (default: gpt-image-1)
 * @param {string} quality      - Calidad: low | medium | high (default: medium)
 * @returns {Buffer} - Buffer de la imagen PNG
 */
async function llamarOpenAIImagen(promptVisual, modelo = 'gpt-image-1', quality = 'medium', size = '1024x1536') {
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
 * @param {string} modelo        - Modelo (gpt-image-1 | gpt-image-1-mini)
 * @param {string} quality       - Calidad: low | medium | high
 * @returns {Buffer} - Buffer de la imagen PNG
 */
async function llamarOpenAIImagenEdits(promptVisual, refImagePath, modelo = 'gpt-image-1', quality = 'medium') {
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
 * Obtiene un access token de OAuth2 usando el service account configurado.
 */
async function obtenerAccessToken() {
  const auth = new GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  const tokenResp = await client.getAccessToken();
  return tokenResp.token;
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
  const ts = () => new Date().toTimeString().slice(0, 8);
  const rutas = [];
  const prompts = Array.isArray(prompt) ? prompt : null;

  for (let i = 0; i < cantidad; i++) {
    const n = i + 1;
    const promptActual = prompts ? (prompts[i] || prompts[prompts.length - 1]) : prompt;
    const ruta = rutaImagen(id, n);
    const urlPublica = `/output/imagenes/imagen-${id}-${n}.png`;

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
        galeria.push({ id, numero: n, ruta, urlPublica, prompt: promptActual, fecha: new Date().toISOString() });
        guardada = true;
        break;
      } catch (err) {
        console.warn(`[${ts()}] Imagen ${n}/${cantidad}: intento ${intento} falló — ${err.message}`);
      }
    }

    if (!guardada) {
      console.error(`[${ts()}] Imagen ${n}/${cantidad}: usando placeholder negro.`);
      crearPlaceholder(ruta);
      galeria.push({ id, numero: n, ruta, urlPublica, prompt: null, fecha: new Date().toISOString() });
    }

    rutas.push(ruta);
    if (onCadaImagen) await onCadaImagen(n, ruta, urlPublica);
  }

  return rutas;
}

/**
 * Crea una imagen placeholder negra de 1080x1920 usando FFmpeg.
 * Se usa como fallback cuando Gemini falla dos veces seguidas.
 *
 * @param {string} ruta - Ruta donde guardar la imagen placeholder
 */
function crearPlaceholder(ruta) {
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  execSync(
    `"${ffmpeg}" -f lavfi -i color=black:size=1080x1920:rate=1 -frames:v 1 -y "${ruta}"`,
    { stdio: 'ignore' }
  );
}

/**
 * Genera todas las imágenes del video de forma secuencial.
 * Para cada imagen: genera prompt (o usa el del storyboard) → llama a la API de imágenes → guarda PNG.
 * Si la API falla, reintenta una vez. Si falla de nuevo, usa placeholder negro.
 *
 * Consistencia de personaje: si no se pasa `refImagePath` (referencia manual del usuario)
 * y la API es OpenAI, la primera imagen generada con éxito se fija como referencia
 * automática (`/v1/images/edits`) para las escenas siguientes del mismo video.
 *
 * @param {string} guion    - Texto del guion mejorado
 * @param {number} cantidad - Número de imágenes a generar
 * @param {string} id       - UUID de la generación
 * @returns {string[]} - Array de rutas absolutas de las imágenes generadas
 */
async function generarImagenes(guion, cantidad, id, onPrompt, modelo, api, estilo = 'cinematico', escenario = 'ninguno', onStoryboard = null, onErrorImagen = null, nichoConfig, refImagePath = null, quality = 'medium') {
  const ts = () => new Date().toTimeString().slice(0, 8);
  console.log(`[${ts()}] Imagenes: generando ${cantidad} imágenes para id ${id} (api=${api} modelo=${modelo} estilo=${estilo} escenario=${escenario} nicho=${nichoConfig.id})...`);

  // Generar storyboard cuando hay más de una imagen para que los prompts sean una secuencia narrativa
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

  const rutas = [];
  // Ancla de consistencia: si no hay refImagePath del usuario, la primera imagen
  // generada se usa como referencia (edits) para las siguientes escenas del mismo video.
  let refAuto = null;

  for (let i = 0; i < cantidad; i++) {
    const n = i + 1;
    const ruta = rutaImagen(id, n);
    const urlPublica = `/output/imagenes/imagen-${id}-${n}.png`;
    const refActual = refImagePath || refAuto;

    let promptVisual;
    if (storyboardPrompts) {
      promptVisual = storyboardPrompts[n - 1];
      if (onPrompt) onPrompt(n, promptVisual);
      console.log(`[${ts()}] Imagen ${n}/${cantidad}: usando prompt de storyboard → llamando ${api}/${modelo}${refActual ? ' (con referencia para consistencia)' : ''}...`);
    } else {
      console.log(`[${ts()}] Imagen ${n}/${cantidad}: generando prompt visual...`);
      try {
        promptVisual = await generarPromptVisual(guion, n, cantidad, estilo, escenario, nichoConfig);
        if (onPrompt) onPrompt(n, promptVisual);
        console.log(`[${ts()}] Imagen ${n}/${cantidad}: prompt listo → llamando ${api}/${modelo}...`);
      } catch (err) {
        console.error(`[${ts()}] Imagen ${n}/${cantidad}: error generando prompt: ${err.message}`);
        crearPlaceholder(ruta);
        galeria.push({ id, numero: n, ruta, urlPublica, prompt: null, fecha: new Date().toISOString() });
        rutas.push(ruta);
        continue;
      }
    }

    // Pausa preventiva entre imágenes para Google (cuota ~2 req/min por defecto)
    if (api === 'google' && n > 1) {
      console.log(`[${ts()}] Imagen ${n}/${cantidad}: esperando 35s para respetar cuota de Google...`);
      await new Promise(r => setTimeout(r, 35000));
    }

    let guardada = false;
    let ultimoError = '';
    for (let intento = 1; intento <= 2; intento++) {
      try {
        let buffer;
        if (api === 'google') {
          buffer = await llamarGoogleImagen(promptVisual, modelo);
        } else if (refActual) {
          buffer = await llamarOpenAIImagenEdits(promptVisual, refActual, modelo, quality);
        } else {
          buffer = await llamarOpenAIImagen(promptVisual, modelo, quality);
        }
        fs.writeFileSync(ruta, buffer);
        console.log(`[${ts()}] Imagen ${n}/${cantidad}: guardada (intento ${intento})`);
        galeria.push({ id, numero: n, ruta, urlPublica, prompt: promptVisual, fecha: new Date().toISOString() });
        guardada = true;
        // Fija la primera imagen generada como referencia automática para las siguientes,
        // solo si el usuario no aportó su propia referencia y la API la soporta.
        if (!refImagePath && !refAuto && api !== 'google') refAuto = ruta;
        break;
      } catch (err) {
        ultimoError = err.message;
        const es429 = err.message.includes('429') || err.message.includes('RESOURCE_EXHAUSTED');
        const pausa = es429 ? 35000 : 4000;
        console.warn(`[${ts()}] Imagen ${n}/${cantidad}: intento ${intento} falló — ${err.message}`);
        if (intento < 2) {
          console.log(`[${ts()}] Imagen ${n}/${cantidad}: esperando ${pausa / 1000}s antes de reintentar...`);
          await new Promise(r => setTimeout(r, pausa));
        }
      }
    }

    if (!guardada) {
      console.error(`[${ts()}] Imagen ${n}/${cantidad}: usando placeholder negro.`);
      crearPlaceholder(ruta);
      galeria.push({ id, numero: n, ruta, urlPublica, prompt: null, fecha: new Date().toISOString() });
      if (onErrorImagen) onErrorImagen(n, ultimoError);
    }

    rutas.push(ruta);
  }

  console.log(`[${ts()}] Imagenes: todas las imágenes generadas.`);
  return rutas;
}

/**
 * Genera todos los prompts visuales en una sola llamada a GPT.
 * Devuelve un array de N strings, uno por fotograma.
 */
async function generarTodosPrompts(guion, cantidad, estilo = 'cinematico', escenario = 'ninguno', nichoConfig) {
  const estiloEN    = ESTILOS_EN[estilo]    || ESTILOS_EN.cinematico;
  const escenarioEN = ESCENARIOS_EN[escenario] || '';

  const content =
    `Actúa como experto en prompts visuales para videos de ${nichoConfig.nombre}. ` +
    `Escribe exactamente ${cantidad} prompts en inglés, uno por párrafo separado por línea en blanco. ` +
    `Cada prompt describe una escena DIFERENTE que juntas narran: ${nichoConfig.imagenes.arcoNarrativo} (adapta según cantidad). ` +
    `Cada prompt empieza con "Create an image of". ` +
    `El estilo visual de TODOS los prompts DEBE ser: ${estiloEN}. ` +
    (escenarioEN ? `El entorno/ambiente de TODOS los prompts DEBE incluir: ${escenarioEN}. ` : '') +
    `Devuelve SOLO los ${cantidad} prompts, sin numeración ni explicaciones. ` +
    `Guion: ${guion}`;

  const resp = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content }],
      temperature: 0.9,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const texto = resp.data.choices[0].message.content.trim();
  let prompts = texto.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 10);

  // Garantizar que tengamos suficientes prompts
  while (prompts.length < cantidad) {
    prompts.push(prompts[prompts.length - 1] || 'Create an image of a person achieving their goals in a cinematic motivational scene.');
  }
  return prompts.slice(0, cantidad);
}

/**
 * Genera imágenes una por una (secuencial).
 * Llama onCadaImagen(n, ruta, urlPublica) después de guardar cada una.
 */
async function generarImagenesSecuencial(guion, cantidad, id, onCadaImagen, onPrompt, estilo = 'cinematico', escenario = 'ninguno', onStoryboard = null, nichoConfig, modelo = 'gpt-image-1', quality = 'medium') {
  const ts = () => new Date().toTimeString().slice(0, 8);

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
    const urlPublica = `/output/imagenes/imagen-${id}-${n}.png`;
    const prompt = prompts[i];

    if (onPrompt) onPrompt(n, prompt);
    console.log(`[${ts()}] Imagen ${n}/${cantidad}: llamando OpenAI (${modelo}, ${quality})...`);

    let guardada = false;

    for (let intento = 1; intento <= 2; intento++) {
      try {
        const buffer = await llamarOpenAIImagen(prompt, modelo, quality);
        fs.writeFileSync(ruta, buffer);
        galeria.push({ id, numero: n, ruta, urlPublica, prompt, fecha: new Date().toISOString() });
        console.log(`[${ts()}] Imagen ${n}/${cantidad}: guardada (intento ${intento}).`);
        guardada = true;
        break;
      } catch (err) {
        console.warn(`[${ts()}] Imagen ${n}/${cantidad}: intento ${intento} falló — ${err.message}`);
      }
    }

    if (!guardada) {
      console.error(`[${ts()}] Imagen ${n}/${cantidad}: usando placeholder negro.`);
      crearPlaceholder(ruta);
      galeria.push({ id, numero: n, ruta, urlPublica, prompt: null, fecha: new Date().toISOString() });
    }

    rutas.push(ruta);
    if (onCadaImagen) await onCadaImagen(n, ruta, urlPublica);
  }

  console.log(`[${ts()}] Imagenes: todas procesadas.`);
  return rutas;
}

module.exports = { generarImagenes, generarImagenesSecuencial, generarImagenesDirectas, generarEsquemaInfografia, obtenerGaleria, llamarOpenAIImagen, llamarGoogleImagen };
