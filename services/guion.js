const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

const { rutaGuion } = require('../utils/archivos');

/**
 * Genera el guion del video en dos pasos:
 *  1. Borrador con GPT-4o (coach motivacional)
 *  2. Mejora del borrador con GPT-4o (copywriter viral)
 * Guarda el guion mejorado en disco y retorna ambas versiones.
 *
 * @param {string} tema - El tema del video motivacional
 * @param {string} id   - UUID de la generación actual
 * @returns {{ guion_final: string, guion_audio: string }}
 */
async function generarGuion(tema, id) {
  const ts = () => new Date().toTimeString().slice(0, 8);
  const headers = {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
  };
  const endpoint = 'https://api.openai.com/v1/chat/completions';

  // ── PASO 1: Borrador ──────────────────────────────────────────────────────
  console.log(`[${ts()}] Guion paso 1: generando borrador para tema "${tema}"...`);
  const respBorrador = await axios.post(endpoint, {
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content:
          'Eres un coach motivacional con más de 10 años de experiencia, ' +
          'influenciado por oradores como Tony Robbins y Norman Vincent Peale. Estás ' +
          'acostumbrado a dar discursos breves y poderosos dirigidos a una audiencia ' +
          'adulta. Tu estilo combina inspiración, claridad y energía emocional.',
      },
      {
        role: 'user',
        content:
          `Escribe un guion para un video corto de YouTube de 120 palabras sobre el tema: ${tema}. ` +
          'El guion debe ser claro, directo, emocional e inspirador, y debe poder usarse como audio ' +
          'sin necesidad de ajustes. Devuelve solo el texto final. Cada oración debe estar en una ' +
          'línea separada. Comienza con una frase que atrape de inmediato la atención del espectador.',
      },
    ],
    temperature: 0.8,
    max_tokens: 1000,
  }, { headers });

  const borrador = respBorrador.data.choices[0].message.content.trim();
  console.log(`[${ts()}] Guion paso 1: borrador generado (${borrador.split('\n').length} líneas).`);

  // ── PASO 2: Mejora ────────────────────────────────────────────────────────
  console.log(`[${ts()}] Guion paso 2: mejorando con copywriter viral...`);
  const respMejora = await axios.post(endpoint, {
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content:
          'Eres un copywriter senior especializado en YouTube Shorts del nicho de motivación ' +
          'y crecimiento personal. Reescribes guiones para que suenen modernos, virales, humanos ' +
          'y memorables.',
      },
      {
        role: 'user',
        content:
          'Edita y mejora este guion como copywriter profesional experto en contenido viral ' +
          'para Shorts. REGLAS: 1. Primera línea debe ser un hook brutal que detenga el scroll. ' +
          '2. Frases cortas, directas y memorables. 3. Tono humano, intenso, inspirador. ' +
          '4. Elimina relleno y frases débiles. 5. Estructura: dolor → verdad incómoda → ' +
          'cambio de perspectiva → impulso final. 6. Cada oración en una línea separada. ' +
          `7. Devuelve únicamente la versión final mejorada. TEXTO ORIGINAL: ${borrador}`,
      },
    ],
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
