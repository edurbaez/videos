const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

const { rutaGuion } = require('../utils/archivos');
const { renderPrompt } = require('../utils/prompts');

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
  const ts = () => new Date().toTimeString().slice(0, 8);
  const headers = {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
  };
  const endpoint = 'https://api.openai.com/v1/chat/completions';

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
  const respBorrador = await axios.post(endpoint, {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: promptBorrador }],
    temperature: 0.8,
    max_tokens: 1000,
  }, { headers });

  const borrador = respBorrador.data.choices[0].message.content.trim();
  console.log(`[${ts()}] Guion paso 1: borrador generado (${borrador.split('\n').length} líneas).`);

  // ── PASO 2: Mejora ────────────────────────────────────────────────────────
  console.log(`[${ts()}] Guion paso 2: mejorando con copywriter viral...`);
  const promptMejora = renderPrompt(nichoConfig.prompts.guionMejora, { ...vars, borrador });
  const respMejora = await axios.post(endpoint, {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: promptMejora }],
    temperature: 0.9,
    max_tokens: 1000,
  }, { headers });

  const guion_final = respMejora.data.choices[0].message.content.trim();
  // Versión audio: todo en una línea para pasarle a TTS
  const guion_audio = guion_final.replace(/\n+/g, ' ').trim();

  // Guardar en disco
  fs.writeFileSync(rutaGuion(id), guion_final, 'utf-8');
  console.log(`[${ts()}] Guion paso 2: guion mejorado guardado en ${rutaGuion(id)}`);

  return { guion_final, guion_audio };
}

module.exports = { generarGuion };
