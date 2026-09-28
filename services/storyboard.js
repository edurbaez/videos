const { chat } = require('./openai');
const { ESTILOS_EN, ESCENARIOS_EN } = require('../utils/estilos');
const { renderPrompt } = require('../utils/prompts');

/**
 * Genera un storyboard estructurado con N escenas a partir del guion usando GPT-4o.
 * Cada escena tiene: numero, sujeto (ES), ambiente (ES), emocion (ES), prompt (EN).
 * Solo se usa cuando cantidad > 1.
 *
 * @param {string} guion       - Texto del guion mejorado
 * @param {number} cantidad    - Número de escenas
 * @param {string} estilo      - Clave de estilo visual
 * @param {string} escenario   - Clave de escenario
 * @param {object} nichoConfig - Objeto retornado por cargarNicho()
 * @returns {{ numero: number, sujeto: string, ambiente: string, emocion: string, prompt: string }[]}
 */
async function generarStoryboard(guion, cantidad, estilo = 'cinematico', escenario = 'ninguno', nichoConfig) {
  const estiloEN    = ESTILOS_EN[estilo]    || ESTILOS_EN.cinematico;
  const escenarioEN = ESCENARIOS_EN[escenario] || '';

  const content = renderPrompt(nichoConfig.prompts.storyboard, {
    guion,
    cantidad,
    nombre_nicho:    nichoConfig.nombre,
    arco_narrativo:  nichoConfig.imagenes.arcoNarrativo,
    estilo_visual_en: estiloEN,
    escenario_regla: escenarioEN ? `5. The environment MUST include: ${escenarioEN}` : '',
  });

  const data = JSON.parse(await chat({ model: 'gpt-4o', prompt: content, temperature: 0.8, json: true }));
  let escenas = Array.isArray(data.escenas) ? data.escenas : [];
  const personaje = data.personaje || 'a determined person';

  const fallback = (n) => ({
    numero: n,
    sujeto: 'Persona determinada avanzando con esfuerzo',
    ambiente: 'Entorno dramático con iluminación contrastada',
    emocion: 'Determinación',
    prompt: `Create an image of ${personaje} in a scene from a ${nichoConfig.nombre} video, ${estiloEN}.`,
  });

  while (escenas.length < cantidad) escenas.push(fallback(escenas.length + 1));
  return escenas.slice(0, cantidad);
}

module.exports = { generarStoryboard };
