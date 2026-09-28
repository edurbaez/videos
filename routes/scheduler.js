const express = require('express');
const seg = require('../middleware/seguridad');
const scheduler = require('../scheduler');

const router = express.Router();

router.get('/scheduler/estado', (req, res) => res.json(scheduler.estado()));

// Manual trigger: only when the scheduler is enabled; the run continues in the background
router.post('/scheduler/ejecutar', seg.limitarGenerar, (req, res) => {
  const { habilitado, enCurso } = scheduler.estado();
  if (!habilitado) return res.status(409).json({ error: 'Scheduler desactivado (SCHEDULER_ENABLED != true).' });
  if (enCurso) return res.status(409).json({ error: 'Ya hay una ejecución automática en curso.' });
  scheduler.ejecutarAhora('manual').catch(() => {});
  res.status(202).json({ ok: true, mensaje: 'Ejecución iniciada. Consulta GET /scheduler/estado.' });
});

module.exports = router;
