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

// ── Estadísticas del canal ────────────────────────────────────────────────────

// Convierte duración ISO 8601 (PT1M30S) a string legible "1:30"
function parseDuracion(iso) {
  if (!iso) return null;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  const h = parseInt(m[1] || '0');
  const min = parseInt(m[2] || '0');
  const s = parseInt(m[3] || '0');
  const mm = h > 0 ? `${h}:${String(min).padStart(2, '0')}` : `${min}`;
  return `${mm}:${String(s).padStart(2, '0')}`;
}

const DIAS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

async function obtenerEstadisticasCanal(canal) {
  const auth = await obtenerClienteAutenticado(canal);
  const ytApi = google.youtube({ version: 'v3', auth });

  // Info del canal
  const chRes = await ytApi.channels.list({
    part: 'snippet,statistics,contentDetails',
    mine: true,
  });
  const ch        = chRes.data.items?.[0];
  if (!ch) throw new Error('No se encontró el canal en YouTube.');
  const uploadsId = ch.contentDetails.relatedPlaylists.uploads;

  const totalVideos     = parseInt(ch.statistics.videoCount   || '0', 10);
  const totalVistas     = parseInt(ch.statistics.viewCount    || '0', 10);
  const canalInfo = {
    id:                   ch.id,
    titulo:               ch.snippet.title,
    descripcion:          ch.snippet.description,
    thumbnail:            ch.snippet.thumbnails?.default?.url || '',
    suscriptores:         ch.statistics.subscriberCount || '0',
    vistasTotal:          ch.statistics.viewCount        || '0',
    videosTotal:          ch.statistics.videoCount       || '0',
    pais:                 ch.snippet.country             || '',
    creadoEn:             ch.snippet.publishedAt         || null,
    promedioVistasPorVideo: totalVideos > 0 ? Math.round(totalVistas / totalVideos) : 0,
  };

  // Últimos 10 videos de la lista de subidos
  const plRes = await ytApi.playlistItems.list({
    part:       'snippet',
    playlistId: uploadsId,
    maxResults: 10,
  });
  const items    = plRes.data.items || [];
  const videoIds = items.map(i => i.snippet.resourceId.videoId).join(',');

  if (!videoIds) return { canal: canalInfo, videos: [], resumen: null };

  // Estadísticas + duración + privacidad en un solo request
  const vRes = await ytApi.videos.list({
    part: 'snippet,statistics,contentDetails,status',
    id:   videoIds,
  });

  const ahora = Date.now();
  const videos = (vRes.data.items || [])
    .map(v => {
      const vistas      = parseInt(v.statistics.viewCount    || '0', 10);
      const likes       = parseInt(v.statistics.likeCount    || '0', 10);
      const comentarios = parseInt(v.statistics.commentCount || '0', 10);
      const diasVivos   = Math.max(1, Math.floor((ahora - new Date(v.snippet.publishedAt)) / 86_400_000));
      const engagement  = vistas > 0 ? parseFloat(((likes + comentarios) / vistas * 100).toFixed(2)) : 0;
      const vistasPorDia = Math.round(vistas / diasVivos);

      return {
        id:           v.id,
        titulo:       v.snippet.title,
        thumbnail:    v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url || '',
        publicadoEn:  v.snippet.publishedAt,
        privacidad:   v.status?.privacyStatus || 'public',
        duracion:     parseDuracion(v.contentDetails?.duration),
        vistas,
        likes,
        comentarios,
        engagement,
        vistasPorDia,
        url: `https://www.youtube.com/watch?v=${v.id}`,
      };
    })
    .sort((a, b) => b.vistas - a.vistas);

  // Mejor día para publicar: promedio de vistas por día de la semana
  const vistasXDia = Array(7).fill(0);
  const countXDia  = Array(7).fill(0);
  videos.forEach(v => {
    const dia = new Date(v.publicadoEn).getDay();
    vistasXDia[dia] += v.vistas;
    countXDia[dia]++;
  });
  let mejorDiaIdx = 0;
  let mejorPromedio = -1;
  vistasXDia.forEach((total, i) => {
    const prom = countXDia[i] > 0 ? total / countXDia[i] : 0;
    if (prom > mejorPromedio) { mejorPromedio = prom; mejorDiaIdx = i; }
  });

  const resumen = {
    mejorDia:         countXDia[mejorDiaIdx] > 0 ? DIAS_ES[mejorDiaIdx] : null,
    videoMasVisto:    videos[0]?.titulo || null,
    promedioVistas:   videos.length > 0 ? Math.round(videos.reduce((s, v) => s + v.vistas, 0) / videos.length) : 0,
    promedioEngagement: videos.length > 0
      ? parseFloat((videos.reduce((s, v) => s + v.engagement, 0) / videos.length).toFixed(2))
      : 0,
  };

  return { canal: canalInfo, videos, resumen };
}

module.exports = {
  obtenerUrlAuth,
  manejarCallback,
  listarCanalesConfig,
  leerCanalesConfig,
  generarMetadatosYoutube,
  generarMetadatosShorts,
  subirVideo,
  obtenerEstadisticasCanal,
};
