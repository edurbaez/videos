const axios = require('axios');
require('dotenv').config();

const { ESTILOS_EN, ESCENARIOS_EN } = require('../utils/estilos');

/**
 * Genera un storyboard estructurado con N escenas a partir del guion usando GPT-4o.
 * Cada escena tiene: numero, descripcion (ES), emocion (ES), prompt (EN).
 * Solo se usa cuando cantidad > 1.
 *
 * @param {string} guion     - Texto del guion mejorado
 * @param {number} cantidad  - Número de escenas
 * @param {string} estilo    - Clave de estilo visual
 * @param {string} escenario - Clave de escenario
 * @returns {{ numero: number, descripcion: string, emocion: string, prompt: string }[]}
 */
async function generarStoryboard(guion, cantidad, estilo = 'cinematico', escenario = 'ninguno') {
  const estiloEN    = ESTILOS_EN[estilo]    || ESTILOS_EN.cinematico;
  const escenarioEN = ESCENARIOS_EN[escenario] || '';

  const content =
    `You are a visual storytelling expert for short motivational videos.\n\n` +

    `## STEP 1 — Define the protagonist (used in ALL scenes)\n` +
    `Before creating scenes, infer a single protagonist from the script. ` +
    `Define them with: approximate age, gender, ethnicity, hair (color, length, style), facial features, ` +
    `body type, and a base outfit that can evolve slightly per scene but stays recognizable. ` +
    `Store this in the "personaje" field. This exact description MUST appear verbatim in every scene prompt.\n\n` +

    `## STEP 2 — Create ${cantidad} scenes with a cohesive narrative arc\n` +
    `The scenes must tell ONE story (e.g., pain → turning point → effort → triumph; adapt arc to scene count). ` +
    `Each scene must be visually distinct yet clearly part of the same story with the SAME protagonist.\n\n` +

    `## STEP 3 — For each scene, define:\n` +
    `- sujeto: precise description of what the protagonist is doing and their physical state/expression in this scene (in Spanish)\n` +
    `- ambiente: precise description of the environment — location, time of day, lighting, weather, camera angle (in Spanish)\n` +
    `- emocion: the dominant mood/emotion of the scene (in Spanish)\n` +
    `- prompt: the full image generation prompt in English\n\n` +

    `## Rules for each "prompt":\n` +
    `1. Start with "Create an image of [protagonist full description from personaje field]"\n` +
    `2. Describe exactly what the protagonist is doing in this scene\n` +
    `3. Describe the environment in detail: location, lighting, time of day, atmosphere\n` +
    `4. End with the style: ${estiloEN}\n` +
    (escenarioEN ? `5. The environment MUST include: ${escenarioEN}\n` : '') +
    `The prompt must be self-contained — someone reading only the prompt must be able to recreate the scene exactly.\n\n` +

    `## Output — return ONLY this JSON:\n` +
    `{\n` +
    `  "personaje": "full protagonist description in English",\n` +
    `  "escenas": [\n` +
    `    {\n` +
    `      "numero": 1,\n` +
    `      "sujeto": "what the protagonist is doing and their expression/state in Spanish",\n` +
    `      "ambiente": "environment, lighting, time of day, camera angle in Spanish",\n` +
    `      "emocion": "mood/emotion in Spanish",\n` +
    `      "prompt": "Create an image of [protagonist] ..."\n` +
    `    }\n` +
    `  ]\n` +
    `}\n\n` +
    `Script: ${guion}`;

  const resp = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o',
      messages: [{ role: 'user', content }],
      temperature: 0.8,
      response_format: { type: 'json_object' },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const data = JSON.parse(resp.data.choices[0].message.content);
  let escenas = Array.isArray(data.escenas) ? data.escenas : [];
  const personaje = data.personaje || 'a determined person';

  const fallback = (n) => ({
    numero: n,
    sujeto: 'Persona determinada avanzando con esfuerzo',
    ambiente: 'Entorno dramático con iluminación contrastada',
    emocion: 'Determinación',
    prompt: `Create an image of ${personaje} overcoming challenges with determination, ${estiloEN}.`,
  });

  while (escenas.length < cantidad) escenas.push(fallback(escenas.length + 1));
  return escenas.slice(0, cantidad);
}

module.exports = { generarStoryboard };
