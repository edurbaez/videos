const express = require('express');
const yt = require('../services/youtube');

const router = express.Router();

const youtubeConfigurado = () => !!(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET);
const escaparHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

router.get('/youtube/canales', (req, res) => {
  if (!youtubeConfigurado()) {
    return res.status(503).json({ error: 'YouTube no configurado. Agrega YOUTUBE_CLIENT_ID y YOUTUBE_CLIENT_SECRET al .env' });
  }
  res.json(yt.listarCanalesConfig());
});

router.get('/youtube/auth', (req, res) => {
  if (!youtubeConfigurado()) return res.status(503).send('YouTube no configurado en .env');
  const canal = yt.listarCanalesConfig().find(c => c.nombre === req.query.canal);
  if (!canal) {
    return res.status(400).type('text/plain').send(`Canal "${String(req.query.canal)}" no encontrado en youtube-channels.json.`);
  }
  res.redirect(yt.obtenerUrlAuth(canal.nombre));
});

router.get('/youtube/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send('Parámetros faltantes en el callback de OAuth.');
  try {
    const canal = await yt.manejarCallback(String(code), String(state));
    const label = yt.listarCanalesConfig().find(c => c.nombre === canal)?.label || canal;
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:system-ui,sans-serif;padding:40px;background:#0d0d0f;color:#e2e8f0;">
  <h2 style="color:#22c55e;">&#10003; Canal "${escaparHtml(label)}" autorizado correctamente</h2>
  <p style="color:#94a3b8;margin-top:12px;">Ya puedes cerrar esta pestaña y volver a
    <a href="/videos_curso.html" style="color:#818cf8;">Videos Curso</a>.
  </p>
</body></html>`);
  } catch (err) {
    console.error('[youtube/callback]', err.message);
    res.status(400).type('text/plain').send(`Error al procesar el callback: ${err.message}`);
  }
});

router.get('/youtube/estadisticas/:canal', async (req, res) => {
  if (!youtubeConfigurado()) return res.status(503).json({ error: 'YouTube no configurado en .env' });
  const { canal } = req.params;
  if (!yt.listarCanalesConfig().find(c => c.nombre === canal)) {
    return res.status(404).json({ error: `Canal "${canal}" no encontrado.` });
  }
  try {
    res.json(await yt.obtenerEstadisticasCanal(canal));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
