const axios = require('axios');
const fs = require('fs');
const { execSync } = require('child_process');
const { GoogleAuth } = require('google-auth-library');
require('dotenv').config();

const { rutaImagen } = require('../utils/archivos');
const { ESTILOS_ES, ESTILOS_EN, ESCENARIOS_EN } = require('../utils/estilos');
const { generarStoryboard } = require('./storyboard');

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
async function generarPromptVisual(guion, n, total, estilo = 'cinematico', escenario = 'ninguno') {
  const estiloES = ESTILOS_ES[estilo] || ESTILOS_ES.cinematico;
  const estiloEN = ESTILOS_EN[estilo] || ESTILOS_EN.cinematico;
  const escenarioEN = ESCENARIOS_EN[escenario] || '';

  const content =
    'Actúa como un experto en prompts visuales para videos motivacionales. ' +
    `Escribe un prompt en inglés para generar una imagen motivacional con estilo ${estiloES}, ` +
    'sujeto principal claro y entorno relevante al mensaje. ' +
    'Debe ser una escena DIFERENTE y COMPLEMENTARIA a las otras escenas del video. ' +
    `Esta es la imagen número ${n} de ${total}, así que mostrá un momento distinto ` +
    'del viaje motivacional (por ejemplo: el dolor inicial, el punto de quiebre, ' +
    "el esfuerzo, el triunfo). Empieza con 'Create an image of'. " +
    `El estilo visual DEBE ser: ${estiloEN}. ` +
    (escenarioEN ? `El entorno/ambiente DEBE incluir: ${escenarioEN}. ` : '') +
    `Devuelve solo el prompt. Texto del guion: ${guion}`;

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
 * Llama a DALL-E 3 para generar una imagen a partir de un prompt visual.
 * Retorna el buffer PNG o lanza un error.
 *
 * @param {string} promptVisual - Prompt en inglés
 * @returns {Buffer} - Buffer de la imagen PNG
 */
async function llamarDallE(promptVisual) {
  let resp;
  try {
    resp = await axios.post(
      'https://api.openai.com/v1/images/generations',
      {
        model: 'dall-e-3',
        prompt: promptVisual,
        n: 1,
        size: '1024x1792',
        quality: 'standard',
        response_format: 'b64_json',
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
    console.error('[DALL-E] Error HTTP:', err.response?.status, detalle);
    throw new Error(`DALL-E HTTP ${err.response?.status}: ${detalle}`);
  }

  const b64 = resp.data.data[0]?.b64_json;
  if (!b64) throw new Error('DALL-E no devolvió imagen en la respuesta.');
  console.log('[DALL-E] Imagen generada correctamente.');
  return Buffer.from(b64, 'base64');
}

/**
 * Llama a OpenAI Images (DALL-E 3 o DALL-E 2) con modelo configurable.
 * DALL-E 3 usa 1024x1792 (9:16); DALL-E 2 usa 1024x1024.
 */
async function llamarOpenAIImagen(promptVisual, modelo = 'dall-e-3') {
  const size = modelo === 'dall-e-3' ? '1024x1792' : '1024x1024';
  let resp;
  try {
    resp = await axios.post(
      'https://api.openai.com/v1/images/generations',
      {
        model: modelo,
        prompt: promptVisual,
        n: 1,
        size,
        response_format: 'b64_json',
        ...(modelo === 'dall-e-3' ? { quality: 'standard' } : {}),
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
async function llamarGoogleImagen(promptVisual, modelo = 'imagen-3.0-generate-002') {
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
          aspectRatio: '9:16',
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
async function generarImagenesDirectas(prompt, cantidad, id, modelo, api, onCadaImagen) {
  const ts = () => new Date().toTimeString().slice(0, 8);
  const rutas = [];

  for (let i = 0; i < cantidad; i++) {
    const n = i + 1;
    const ruta = rutaImagen(id, n);
    const urlPublica = `/output/imagenes/imagen-${id}-${n}.png`;

    console.log(`[${ts()}] Imagen directa ${n}/${cantidad}: api=${api} modelo=${modelo}...`);

    let guardada = false;
    for (let intento = 1; intento <= 2; intento++) {
      try {
        let buffer;
        if (api === 'google') {
          buffer = await llamarGoogleImagen(prompt, modelo);
        } else {
          buffer = await llamarOpenAIImagen(prompt, modelo);
        }
        fs.writeFileSync(ruta, buffer);
        galeria.push({ id, numero: n, ruta, urlPublica, prompt, fecha: new Date().toISOString() });
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
 * Genera todas las imágenes del video en paralelo.
 * Para cada imagen: genera prompt → llama Gemini → guarda PNG.
 * Si Gemini falla, reintenta una vez. Si falla de nuevo, usa placeholder negro.
 *
 * @param {string} guion    - Texto del guion mejorado
 * @param {number} cantidad - Número de imágenes a generar
 * @param {string} id       - UUID de la generación
 * @returns {string[]} - Array de rutas absolutas de las imágenes generadas
 */
async function generarImagenes(guion, cantidad, id, onPrompt, modelo, api, estilo = 'cinematico', escenario = 'ninguno', onStoryboard = null, onErrorImagen = null) {
  const ts = () => new Date().toTimeString().slice(0, 8);
  console.log(`[${ts()}] Imagenes: generando ${cantidad} imágenes para id ${id} (api=${api} modelo=${modelo} estilo=${estilo} escenario=${escenario})...`);

  // Generar storyboard cuando hay más de una imagen para que los prompts sean una secuencia narrativa
  let storyboardPrompts = null;
  if (cantidad > 1) {
    console.log(`[${ts()}] Imagenes: generando storyboard para ${cantidad} escenas...`);
    try {
      const escenas = await generarStoryboard(guion, cantidad, estilo, escenario);
      if (onStoryboard) onStoryboard(escenas);
      storyboardPrompts = escenas.map(e => e.prompt);
      console.log(`[${ts()}] Imagenes: storyboard listo con ${escenas.length} escenas.`);
    } catch (err) {
      console.warn(`[${ts()}] Imagenes: error generando storyboard (${err.message}), usando prompts individuales.`);
    }
  }

  const rutas = [];

  for (let i = 0; i < cantidad; i++) {
    const n = i + 1;
    const ruta = rutaImagen(id, n);
    const urlPublica = `/output/imagenes/imagen-${id}-${n}.png`;

    let promptVisual;
    if (storyboardPrompts) {
      promptVisual = storyboardPrompts[n - 1];
      if (onPrompt) onPrompt(n, promptVisual);
      console.log(`[${ts()}] Imagen ${n}/${cantidad}: usando prompt de storyboard → llamando ${api}/${modelo}...`);
    } else {
      console.log(`[${ts()}] Imagen ${n}/${cantidad}: generando prompt visual...`);
      try {
        promptVisual = await generarPromptVisual(guion, n, cantidad, estilo, escenario);
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
        } else {
          buffer = await llamarOpenAIImagen(promptVisual, modelo);
        }
        fs.writeFileSync(ruta, buffer);
        console.log(`[${ts()}] Imagen ${n}/${cantidad}: guardada (intento ${intento})`);
        galeria.push({ id, numero: n, ruta, urlPublica, prompt: promptVisual, fecha: new Date().toISOString() });
        guardada = true;
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
async function generarTodosPrompts(guion, cantidad, estilo = 'cinematico', escenario = 'ninguno') {
  const estiloEN = ESTILOS_EN[estilo] || ESTILOS_EN.cinematico;
  const escenarioEN = ESCENARIOS_EN[escenario] || '';

  const content =
    `Actúa como experto en prompts visuales para videos motivacionales. ` +
    `Escribe exactamente ${cantidad} prompts en inglés, uno por párrafo separado por línea en blanco. ` +
    `Cada prompt describe una escena DIFERENTE que juntas narran el viaje motivacional: ` +
    `dolor inicial → quiebre → esfuerzo → triunfo (adapta según cantidad). ` +
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
async function generarImagenesSecuencial(guion, cantidad, id, onCadaImagen, onPrompt, estilo = 'cinematico', escenario = 'ninguno', onStoryboard = null) {
  const ts = () => new Date().toTimeString().slice(0, 8);

  let prompts;
  if (cantidad > 1) {
    console.log(`[${ts()}] Imagenes: generando storyboard para ${cantidad} escenas (estilo=${estilo} escenario=${escenario})...`);
    try {
      const escenas = await generarStoryboard(guion, cantidad, estilo, escenario);
      if (onStoryboard) onStoryboard(escenas);
      prompts = escenas.map(e => e.prompt);
      console.log(`[${ts()}] Imagenes: storyboard listo. Procesando secuencialmente...`);
    } catch (err) {
      console.warn(`[${ts()}] Imagenes: error en storyboard (${err.message}), usando prompts en bloque.`);
      prompts = await generarTodosPrompts(guion, cantidad, estilo, escenario);
    }
  } else {
    console.log(`[${ts()}] Imagenes: generando 1 prompt (sin storyboard)...`);
    prompts = await generarTodosPrompts(guion, 1, estilo, escenario);
  }
  console.log(`[${ts()}] Imagenes: ${prompts.length} prompts listos. Procesando secuencialmente...`);

  const rutas = [];

  for (let i = 0; i < cantidad; i++) {
    const n = i + 1;
    const ruta = rutaImagen(id, n);
    const urlPublica = `/output/imagenes/imagen-${id}-${n}.png`;
    const prompt = prompts[i];

    if (onPrompt) onPrompt(n, prompt);
    console.log(`[${ts()}] Imagen ${n}/${cantidad}: llamando DALL-E...`);

    let guardada = false;

    for (let intento = 1; intento <= 2; intento++) {
      try {
        const buffer = await llamarDallE(prompt);
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

module.exports = { generarImagenes, generarImagenesSecuencial, generarImagenesDirectas, obtenerGaleria };
