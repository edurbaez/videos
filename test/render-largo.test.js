const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  planificarEscenas, filtroSegmento, filtroAudio, loudnormLineal, elegirMusica, movimientoKenBurns, expresionesKenBurns,
} = require('../services/video');
const { quitarCitas, deduplicarTextos, componerPrompt, escribirAss } = require('../services/escenasLargo');

const escenasDe = limites => limites.slice(0, -1).map((inicio, i) => ({ imagen: `img${i}.png`, inicio, fin: limites[i + 1] }));

test('planificarEscenas: frames cover the audio exactly and transitions are centered on scene boundaries', () => {
  const plan = planificarEscenas(escenasDe([0, 20, 41.3, 60, 83.33]), 83.33, { fps: 25, transicion: 0.6, segundosSegmento: 1000 });
  assert.equal(plan.total, Math.round(83.33 * 25));
  assert.equal(plan.segmentos.length, 1);
  const [seg] = plan.segmentos;
  assert.equal(seg.inicio, 0);
  assert.equal(seg.fin, plan.total);
  // 4 overlapping clips, each overlap = 2 * round(0.3 * 25) frames, centered on the boundary frame
  const bordes = [20, 41.3, 60].map(t => Math.round(t * 25));
  for (let k = 1; k < seg.tomas.length; k++) {
    const prev = seg.tomas[k - 1];
    const t = seg.tomas[k];
    assert.equal(prev.hasta - t.desde, 16);
    assert.equal((prev.hasta + t.desde) / 2, bordes[k - 1]);
  }
  // Sum of clip lengths minus overlaps equals the total (video length matches audio)
  const suma = seg.tomas.reduce((s, t) => s + (t.hasta - t.desde), 0);
  const solapes = seg.tomas.slice(1).reduce((s, t, k) => s + (seg.tomas[k].hasta - t.desde), 0);
  assert.equal(suma - solapes, plan.total);
});

test('planificarEscenas: segments are cut mid-scene, outside transitions, and continue the Ken Burns offset', () => {
  const limites = [0];
  for (let i = 1; i <= 30; i++) limites.push(i * 20);
  const plan = planificarEscenas(escenasDe(limites), 600, { fps: 25, transicion: 0.6, segundosSegmento: 120 });
  assert.ok(plan.segmentos.length >= 4);
  assert.equal(plan.segmentos[0].inicio, 0);
  assert.equal(plan.segmentos.at(-1).fin, plan.total);
  for (let k = 1; k < plan.segmentos.length; k++) {
    const a = plan.segmentos[k - 1];
    const b = plan.segmentos[k];
    assert.equal(a.fin, b.inicio);
    const ultima = a.tomas.at(-1);
    const primera = b.tomas[0];
    // same scene split in two: same image/movement, offset continues where the previous part stopped
    assert.equal(ultima.mov, primera.mov);
    assert.equal(ultima.largo, primera.largo);
    assert.equal(primera.offset, ultima.offset + (ultima.hasta - ultima.desde));
    // the cut is far from any transition
    assert.ok(a.tomas.length < 2 || a.tomas.at(-2).hasta < a.fin);
  }
});

test('planificarEscenas: very short scenes get shorter transitions and zero-length scenes are dropped', () => {
  const plan = planificarEscenas(escenasDe([0, 10, 10.2, 10.2, 20]), 20, { fps: 25, transicion: 0.8, segundosSegmento: 1000 });
  const tomas = plan.segmentos[0].tomas;
  assert.equal(tomas.length, 3);
  // middle scene is 5 frames long: half-transition limited to floor(5 / 4) = 1
  assert.equal(tomas[0].hasta - tomas[1].desde, 2);
  tomas.forEach(t => assert.ok(t.hasta > t.desde));
});

test('movimientoKenBurns: consecutive scenes never repeat the movement', () => {
  for (let i = 0; i < 50; i++) assert.notDeepEqual(movimientoKenBurns(i), movimientoKenBurns(i + 1));
  assert.deepEqual(movimientoKenBurns(0), movimientoKenBurns(6));
});

test('expresionesKenBurns: progress uses the global frame of the clip', () => {
  const e = expresionesKenBurns({ z: [1, 1.12], x: [0.5, 0.5], y: [0.5, 0.5] }, 30, 101);
  assert.equal(e.z, '(1+0.12*((on+30)/100))');
  assert.equal(e.x, '(iw-iw/zoom)*0.5');
});

test('filtroSegmento: zoompan per input, xfade offsets relative to the segment and ASS shifted to global time', () => {
  const plan = planificarEscenas(escenasDe([0, 20, 40, 60, 80, 100, 120, 140, 160]), 160, { fps: 25, transicion: 0.6, segundosSegmento: 60 });
  const seg = plan.segmentos[1];
  const { entradas, filtro } = filtroSegmento(seg, { fps: 25, ancho: 1080, alto: 1920, rutaAss: 'C:\\tmp\\textos.ass' });
  assert.equal(entradas.length, seg.tomas.length);
  assert.equal((filtro.match(/zoompan=/g) || []).length, seg.tomas.length);
  assert.equal((filtro.match(/xfade=/g) || []).length, seg.tomas.length - 1);
  assert.match(filtro, /scale=2160:3840:force_original_aspect_ratio=increase,crop=2160:3840/);
  assert.match(filtro, /s=1080x1920:fps=25/);
  const offset = (seg.tomas[1].desde - seg.inicio) / 25;
  assert.ok(filtro.includes(`duration=0.64:offset=${+offset.toFixed(6)}[x1]`));
  assert.ok(filtro.includes(`setpts=PTS+${seg.inicio / 25}/TB,subtitles=filename='C\\:/tmp/textos.ass',setpts=PTS-STARTPTS[vout]`));
});

test('filtroSegmento: without captions the graph ends in a passthrough', () => {
  const plan = planificarEscenas(escenasDe([0, 5]), 5, { fps: 25 });
  const { filtro } = filtroSegmento(plan.segmentos[0], { fps: 25, ancho: 1920, alto: 1080 });
  assert.match(filtro, /\[t0\]null\[vout\]$/);
});

test('filtroAudio: music is looped-trimmed, ducked by the voice and mixed before loudnorm', () => {
  const con = filtroAudio({ duracion: 600, conMusica: true, loudnorm: 'loudnorm=I=-14' });
  assert.match(con, /atrim=0:600/);
  assert.match(con, /\[mus\]\[guia\]sidechaincompress=/);
  assert.match(con, /amix=inputs=2:duration=first:normalize=0\[mezcla\]/);
  assert.match(con, /afade=t=out:st=597:d=3/);
  assert.match(con, /\[mezcla\]loudnorm=I=-14,aresample=48000\[aout\]$/);
  const sin = filtroAudio({ duracion: 600, conMusica: false, loudnorm: 'loudnorm=I=-14' });
  assert.doesNotMatch(sin, /\[1:a\]|sidechain/);
});

test('loudnormLineal: uses measured values, falls back to dynamic mode on silence or missing data', () => {
  const stderr = `[Parsed_loudnorm_0 @ 0x1]\n{\n\t"input_i" : "-19.52",\n\t"input_tp" : "-3.10",\n\t"input_lra" : "4.20",\n\t"input_thresh" : "-29.80",\n\t"output_i" : "-14.0",\n\t"target_offset" : "0.12"\n}\n`;
  assert.equal(loudnormLineal(stderr),
    'loudnorm=I=-14:TP=-2:LRA=11:measured_I=-19.52:measured_TP=-3.1:measured_LRA=4.2:measured_thresh=-29.8:offset=0.12:linear=true');
  assert.equal(loudnormLineal('{"input_i" : "-inf", "input_tp": "-inf", "input_lra": "0", "input_thresh": "-inf", "target_offset": "inf"}'), 'loudnorm=I=-14:TP=-2:LRA=11');
  assert.equal(loudnormLineal('nada'), 'loudnorm=I=-14:TP=-2:LRA=11');
});

test('elegirMusica: deterministic pick, ignores non-audio files and honors LARGO_MUSICA=false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'musica-'));
  try {
    assert.equal(elegirMusica('x', dir), null);
    fs.writeFileSync(path.join(dir, '.gitkeep'), '');
    fs.writeFileSync(path.join(dir, 'notas.txt'), '');
    assert.equal(elegirMusica('x', dir), null);
    ['a.mp3', 'b.wav', 'c.m4a'].forEach(f => fs.writeFileSync(path.join(dir, f), ''));
    const elegida = elegirMusica('largo-123.mp4', dir);
    assert.ok(/\.(mp3|wav|m4a)$/.test(elegida));
    assert.equal(elegirMusica('largo-123.mp4', dir), elegida);
    const previo = process.env.LARGO_MUSICA;
    process.env.LARGO_MUSICA = 'false';
    try { assert.equal(elegirMusica('largo-123.mp4', dir), null); } finally {
      if (previo === undefined) delete process.env.LARGO_MUSICA; else process.env.LARGO_MUSICA = previo;
    }
    assert.equal(elegirMusica('x', path.join(dir, 'no-existe')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deduplicarTextos: blanks captions repeated (normalized) within the previous 3 shown scenes', () => {
  const escenas = ['„Ich versuche, Deutsch zu lernen.“', 'B', 'ich versuche deutsch zu lernen', 'C', 'D', 'E', '"Ich versuche, Deutsch zu lernen!"', '']
    .map(textoPantalla => ({ textoPantalla }));
  deduplicarTextos(escenas);
  assert.deepEqual(escenas.map(e => e.textoPantalla),
    ['„Ich versuche, Deutsch zu lernen.“', 'B', '', 'C', 'D', 'E', '"Ich versuche, Deutsch zu lernen!"', '']);
});

test('escribirAss: does not emit a caption repeated in a nearby scene', () => {
  const ruta = path.join(os.tmpdir(), `test-${process.pid}.ass`);
  try {
    const n = escribirAss([
      { inicio: 0, fin: 10, textoPantalla: 'zu + Infinitiv' },
      { inicio: 10, fin: 20, textoPantalla: 'Zu + infinitiv' },
      { inicio: 20, fin: 30, textoPantalla: 'Otro' },
    ], ruta);
    assert.equal(n, 2);
  } finally {
    fs.rmSync(ruta, { force: true });
  }
});

test('quitarCitas / componerPrompt: quoted words never reach the image model', () => {
  assert.equal(quitarCitas("two verbs connected by a bright orange 'zu' arrow, the teacher's hand"),
    "two verbs connected by a bright orange symbol arrow, the teacher's hand");
  assert.equal(quitarCitas('icons like "wichtig" and „einfach“ or «hola» and “x” and ‘y’'),
    'icons like a symbol and a symbol or a symbol and a symbol and a symbol');
  assert.equal(quitarCitas("the students' desks and the teacher's board"), "the students' desks and the teacher's board");
  const prompt = componerPrompt({ estilo: 'Flat vector.', personajes: '' }, { prompt: "A sign labeled 'Hallo'." }, 'horizontal');
  assert.doesNotMatch(prompt, /Hallo/);
  assert.match(prompt, /Scene: A sign labeled a symbol\./);
});
