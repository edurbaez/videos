const fs = require('fs');

const { chat } = require('./openai');
const { ts } = require('../utils/log');

const { rutaGuion } = require('../utils/archivos');
const { renderPrompt } = require('../utils/prompts');

const MODELO_GUION_DEFAULT = 'gpt-4o';
const MODELOS_GUION = new Set(['gpt-4o', 'gpt-4o-mini']);

/** Draft model from the niche's guion.modelo (whitelisted); the improvement step always uses gpt-4o. */
function modeloBorrador(nichoConfig) {
  const modelo = nichoConfig.guion?.modelo;
  if (!modelo) return MODELO_GUION_DEFAULT;
  if (MODELOS_GUION.has(modelo)) return modelo;
  console.warn(`[${ts()}] Guion: modelo "${String(modelo).slice(0, 40)}" del nicho ${nichoConfig.id} no permitido, se usa ${MODELO_GUION_DEFAULT}.`);
  return MODELO_GUION_DEFAULT;
}

/**
 * Genera el guion del video en dos pasos:
 *  1. Borrador con GPT-4o (rol definido por el nicho)
 *  2. Mejora del borrador con GPT-4o (copywriter del nicho)
 * Guarda el guion mejorado en disco y retorna ambas versiones.
 *
 * @param {string} tema        - El tema del video
 * @param {string} id          - UUID de la generación actual
 * @param {object} nichoConfig - Objeto retornado por cargarNicho()
 * @returns {{ guion_final: string, guion_audio: string }}
 */
async function generarGuion(tema, id, nichoConfig) {
  const vars = {
    tema,
    nombre_nicho:     nichoConfig.nombre,
    idioma:           nichoConfig.idioma,
    tono:             nichoConfig.guion.tono,
    estructura:       nichoConfig.guion.estructura,
    palabras_objetivo: nichoConfig.guion.palabrasObjetivo,
  };

  // ── PASO 1: Borrador ──────────────────────────────────────────────────────
  console.log(`[${ts()}] Guion paso 1: generando borrador para tema "${tema}" (nicho: ${nichoConfig.id})...`);
  const promptBorrador = renderPrompt(nichoConfig.prompts.guionBorrador, vars);
  const borrador = await chat({ model: modeloBorrador(nichoConfig), prompt: promptBorrador, temperature: 0.8, maxTokens: 1000 });
  console.log(`[${ts()}] Guion paso 1: borrador generado (${borrador.split('\n').length} líneas).`);

  // ── PASO 2: Mejora ────────────────────────────────────────────────────────
  console.log(`[${ts()}] Guion paso 2: mejorando con copywriter viral...`);
  const promptMejora = renderPrompt(nichoConfig.prompts.guionMejora, { ...vars, borrador });
  const guion_final = await chat({ model: 'gpt-4o', prompt: promptMejora, temperature: 0.9, maxTokens: 1000 });
  // Versión audio: todo en una línea para pasarle a TTS
  const guion_audio = guion_final.replace(/\n+/g, ' ').trim();

  // Guardar en disco
  fs.writeFileSync(rutaGuion(id), guion_final, 'utf-8');
  console.log(`[${ts()}] Guion paso 2: guion mejorado guardado en ${rutaGuion(id)}`);

  return { guion_final, guion_audio };
}

module.exports = { generarGuion, modeloBorrador };
