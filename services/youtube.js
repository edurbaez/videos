const { google } = require('googleapis');
const fs          = require('fs');
const path        = require('path');
const axios       = require('axios');

const CHANNELS_CONFIG = path.join(__dirname, '..', 'youtube-channels.json');
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];

const LANG_NAMES = {
  de: 'German (Deutsch)', en: 'English', es: 'Spanish (Español)',
  fr: 'French (Français)', pt: 'Portuguese (Português)',
};

// ── OAuth helpers ─────────────────────────────────────────────────────────────

function tokenPath(canal) {
  return path.join(__dirname, '..', `youtube-tokens-${canal}.json`);
}

function crearCliente() {
  return new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET,
    process.env.YOUTUBE_REDIRECT_URI,
  );
}

function obtenerUrlAuth(canal) {
  const client = crearCliente();
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state: canal,
  });
}

async function manejarCallback(code, canal) {
  const client = crearCliente();
  const { tokens } = await client.getToken(code);
  fs.writeFileSync(tokenPath(canal), JSON.stringify(tokens, null, 2));
  return tokens;
}

function cargarTokens(canal) {
  const p = tokenPath(canal);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

async function obtenerClienteAutenticado(canal) {
  const tokens = cargarTokens(canal);
  if (!tokens) {
    throw new Error(`Canal "${canal}" no autorizado. Visita /youtube/auth?canal=${canal} para autorizar.`);
  }
  const client = crearCliente();
  client.setCredentials(tokens);
  // Persiste el refresh automático si googleapis renueva el token
  client.on('tokens', (newTokens) => {
    const current = cargarTokens(canal) || {};
    fs.writeFileSync(tokenPath(canal), JSON.stringify({ ...current, ...newTokens }, null, 2));
  });
  return client;
}

// ── Canales config ────────────────────────────────────────────────────────────

function leerCanalesConfig() {
  if (!fs.existsSync(CHANNELS_CONFIG)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(CHANNELS_CONFIG, 'utf-8'));
    return Array.isArray(data.canales) ? data.canales : [];
  } catch {
    return [];
  }
}

function listarCanalesConfig() {
  return leerCanalesConfig().map(c => ({
    nombre:     c.nombre,
    label:      c.label || c.nombre,
    descripcion: c.descripcion || '',
    autorizado: fs.existsSync(tokenPath(c.nombre)),
  }));
}

// ── Generación de metadatos con GPT-4o-mini ───────────────────────────────────

function authHeader() {
  return {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function gptMini(prompt, maxTokens = 200) {
  const resp = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    { model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], temperature: 0.7, max_tokens: maxTokens },
    { headers: authHeader() },
  );
  return resp.data.choices[0].message.content.trim();
}

async function generarMetadatosYoutube(tema, guion, idioma, nivel) {
  const langName  = LANG_NAMES[idioma] || idioma;
  const extracto  = guion.slice(0, 300);

  const PROMPT_TITULO = `You are a YouTube SEO expert for educational content. Generate ONE optimized YouTube title.

Context:
- User topic / instruction: ${tema}
- Script language: ${langName}
- Language level: ${nivel}
- Script excerpt: "${extracto}..."

Rules:
- Title MUST be in ${langName} (same language as the script)
- Length: 50–70 characters
- Include the main topic keyword naturally
- Clear and specific, educational tone, no clickbait
- Output ONLY the title text, nothing else.`;

  const PROMPT_DESCRIPCION = `You are a YouTube content creator for an educational channel. Write a bilingual YouTube description for a short educational video.

Context:
- User topic / instruction: ${tema}
- Script language: ${langName}
- Language level: ${nivel}

Output EXACTLY in this format (no extra lines before or after):
🇩🇪 [2–3 sentences in German about what viewers will learn]

🇪🇸 [2–3 sentences in Spanish about what viewers will learn]

#tag1 #tag2 #tag3 #tag4 #tag5 #tag6 #tag7 #tag8

Rules:
- German section: ALWAYS in German regardless of script language
- Spanish section: ALWAYS in Spanish regardless of script language
- Hashtags: topic keywords + level tag (e.g. #${nivel} #${langName.split(' ')[0]}) + educational terms
- Concise and informative
- Output ONLY the formatted text above, nothing else.`;

  const PROMPT_TAGS = `Generate 12 YouTube tags for an educational video.
Topic: ${tema}
Script language: ${langName}
Level: ${nivel}

Rules:
- Mix: topic keywords, level terms (e.g. "${nivel}", "intermediate"), educational terms, language name
- Each tag max 30 characters, no # symbol
- Output comma-separated values only, no numbering, no extra text.`;

  const [titulo, descripcion, tagsRaw] = await Promise.all([
    gptMini(PROMPT_TITULO, 100),
    gptMini(PROMPT_DESCRIPCION, 500),
    gptMini(PROMPT_TAGS, 200),
  ]);

  const tags = tagsRaw.split(',').map(t => t.trim()).filter(Boolean).slice(0, 14);
  tags.push('Shorts');

  // Añadir #Shorts al título para que YouTube lo clasifique como Short
  const tituloShort = titulo.endsWith('#Shorts') ? titulo : `${titulo} #Shorts`;

  return { titulo: tituloShort, descripcion, tags };
}

// ── Subida a YouTube ──────────────────────────────────────────────────────────

async function subirVideo({ rutaVideo, titulo, descripcion, tags, canal, privacidad = 'private' }) {
  const auth    = await obtenerClienteAutenticado(canal);
  const youtube = google.youtube({ version: 'v3', auth });

  const resp = await youtube.videos.insert({
    part: 'snippet,status',
    requestBody: {
      snippet: {
        title:       titulo,
        description: descripcion,
        tags,
        categoryId:  '27', // Education
      },
      status: {
        privacyStatus:             privacidad,
        selfDeclaredMadeForKids:   false,
      },
    },
    media: {
      body: fs.createReadStream(rutaVideo),
    },
  });

  return {
    videoId: resp.data.id,
    url:     `https://www.youtube.com/watch?v=${resp.data.id}`,
  };
}

async function generarMetadatosShorts(tema, guion, nichoNombre) {
  const extracto = guion.slice(0, 300);

  const PROMPT_TITULO = `You are a YouTube SEO expert. Generate ONE optimized YouTube Shorts title.
Topic: ${tema}
Niche: ${nichoNombre}
Script excerpt: "${extracto}..."
Rules:
- Language: Spanish
- Length: 50–70 characters
- Include main keyword naturally
- Engaging, motivational tone, no clickbait
- Output ONLY the title text, nothing else.`;

  const PROMPT_DESCRIPCION = `You are a YouTube content creator. Write a description for a YouTube Short.
Topic: ${tema}
Niche: ${nichoNombre}
Format:
[2–3 sentences in Spanish describing the video content]

#hashtag1 #hashtag2 #hashtag3 #hashtag4 #hashtag5 #hashtag6 #hashtag7
Rules:
- All in Spanish
- Motivational tone
- Hashtags: topic keywords + #Shorts + niche terms
- Output ONLY the formatted text, nothing else.`;

  const PROMPT_TAGS = `Generate 12 YouTube tags for a motivational Short video.
Topic: ${tema}
Niche: ${nichoNombre}
Rules:
- Mix: topic keywords, niche terms, motivational terms
- Each tag max 30 characters, no # symbol
- Output comma-separated values only.`;

  const [titulo, descripcion, tagsRaw] = await Promise.all([
    gptMini(PROMPT_TITULO, 100),
    gptMini(PROMPT_DESCRIPCION, 400),
    gptMini(PROMPT_TAGS, 200),
  ]);

  const tags = tagsRaw.split(',').map(t => t.trim()).filter(Boolean).slice(0, 14);
  tags.push('Shorts');

  const tituloShort = titulo.endsWith('#Shorts') ? titulo : `${titulo} #Shorts`;

  return { titulo: tituloShort, descripcion, tags };
}

module.exports = {
  obtenerUrlAuth,
  manejarCallback,
  listarCanalesConfig,
  leerCanalesConfig,
  generarMetadatosYoutube,
  generarMetadatosShorts,
  subirVideo,
};
