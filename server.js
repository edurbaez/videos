require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

const { crearCarpetas } = require('./utils/archivos');
const seg = require('./middleware/seguridad');

// Default timeout for every axios call (services share the instance).
// Images, Whisper and Telegram uploads raise it to 180 s in their own call.
require('axios').defaults.timeout = 120_000;

crearCarpetas();

const app = express();

// CORS: only the configured origin (or localhost in dev)
app.use(cors({
  origin: process.env.CORS_ORIGIN || `http://localhost:${process.env.PORT || 3000}`,
}));

app.use(seg.limitarGlobal);

// The frontend (HTML/JS, no secrets) loads without API_KEY so it can ask for the key
app.use(express.static(path.join(__dirname, 'public')));
app.use(seg.validarApiKey);

app.use(express.json());

app.use('/output', express.static(path.join(__dirname, 'output')));

app.use(require('./routes/util'));
app.use(require('./routes/shorts'));
app.use(require('./routes/curso'));
app.use(require('./routes/largo'));
app.use(require('./routes/youtube'));
app.use(require('./routes/scheduler'));

// In production (NODE_ENV=production) a generic message avoids leaking internal paths, tokens or stack traces
app.use((err, req, res, _next) => {
  console.error('[ERROR GLOBAL]', err.message);
  res.status(err.status || 500).json({ error: seg.mensajeError(err) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n[servidor] Corriendo en http://localhost:${PORT}`);
  require('./scheduler').iniciar();
});
