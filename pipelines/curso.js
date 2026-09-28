const fs = require('fs');
const path = require('path');
const { DIR_CURSO, urlCurso } = require('../utils/archivos');
const { ts } = require('../utils/log');
const { LANG_NAMES } = require('../utils/constantes');
const { renderPrompt } = require('../utils/prompts');
const { resolverVozGoogle } = require('../services/audio');
const { chat } = require('../services/guionLargo');
const { generarAudioLargo } = require('../services/audioLargo');
const { agruparEscenas, dirigirArte, generarImagenesEscenas, escribirAss, FORMATOS } = require('../services/escenasLargo');
const { generarVideoEscenas } = require('../services/video');
const yt = require('../services/youtube');
const { cola } = require('../lib/cola');
const { guardarEntrada } = require('../utils/historial');

const DIR_PROMPTS_CURSO = path.join(__dirname, '..', 'prompts', 'curso');
const leerPromptCurso = nombre => fs.readFileSync(path.join(DIR_PROMPTS_CURSO, nombre), 'utf-8');

// Prompts saved in the frontend use {placeholder}; renderPrompt expects {{placeholder}}
const llavesDobles = plantilla => plantilla.replace(/(?<!\{)\{(\w+)\}(?!\})/g, '{{$1}}');

const RE_ARCHIVO_CURSO = /^(audio|video)(\d+)\.(mp3|txt|mp4)$/;

/**
 * Reserves the next sequence number in output/curso/ by creating audio<n>.txt exclusively ('wx'),
 * so two simultaneous requests never get the same number.
 */
function reservarNumero() {
  const nums = fs.readdirSync(DIR_CURSO)
    .map(f => { const m = f.match(RE_ARCHIVO_CURSO); return m ? parseInt(m[2]) : 0; })
    .filter(n => n > 0);
  let n = nums.length ? Math.max(...nums) + 1 : 1;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(path.join(DIR_CURSO, `audio${n}.txt`), 'wx'));
      return n;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      n++;
    }
  }
}

/** Lists course files sorted by number, newest first */
function listarArchivos() {
  if (!fs.existsSync(DIR_CURSO)) return [];
  const nums = new Set();
  fs.readdirSync(DIR_CURSO).forEach(f => { const m = f.match(RE_ARCHIVO_CURSO); if (m) nums.add(parseInt(m[2])); });
  return [...nums].sort((a, b) => b - a).map(n => {
    let texto = '';
    try { texto = fs.readFileSync(path.join(DIR_CURSO, `audio${n}.txt`), 'utf-8'); } catch {}
    return {
      numero: n,
      mp3:   urlCurso(`audio${n}.mp3`),
      txt:   urlCurso(`audio${n}.txt`),
      video: fs.existsSync(path.join(DIR_CURSO, `video${n}.mp4`)) ? urlCurso(`video${n}.mp4`) : null,
      texto,
    };
  });
}

/**
 * Course pipeline: script → humanized script → TTS → (video mode) art direction + images + vertical video
 * → (optional) YouTube. Resolves with the final payload; on failure emits 'pipeline_error' and rejects.
 *
 * @param {object} p - { id, tema, idioma, genero, nivel, palabras, modo, cantidadImagenes, apiImagen, modeloImagen,
 *                       promptPersonalizado, promptHumanizacion, youtube: { subirYoutube, canalYoutube, privacidadYoutube, publicarYoutubeEn } }
 * @param {(evento: string, datos: object) => void} emit
 */
async function ejecutarSinCola(p, emit) {
  const { id, tema, idioma, genero, nivel, modo } = p;
  const youtube = p.youtube || {};
  let rutaTxt = null;
  try {
    const numero = reservarNumero();
    rutaTxt = path.join(DIR_CURSO, `audio${numero}.txt`);
    const rutaMp3 = path.join(DIR_CURSO, `audio${numero}.mp3`);
    const langName = LANG_NAMES[idioma];
    const varsPrompt = { tema, nivel, idioma_code: idioma, idioma_nombre: langName };

    emit('progreso', { paso: 1, mensaje: `Generando guion en ${langName}...` });
    console.log(`[${ts()}] Curso: generando audio${numero} idioma=${idioma} genero=${genero} tema="${tema}"`);

    const palabrasLinea = p.palabras
      ? `\n⚠ PRIORITY REQUIREMENT — You MUST use ALL of the following words or phrases at least once in the script. This is mandatory, not optional:\n${p.palabras}\nBuild the script around these words whenever possible.\n`
      : '';
    const promptGuion = p.promptPersonalizado
      || renderPrompt(leerPromptCurso('guion.txt'), { ...varsPrompt, palabras_linea: palabrasLinea });
    const guionBorrador = await chat(promptGuion, { maxTokens: 800, temperature: 0.8 });
    emit('guion_listo', { numero, guion: guionBorrador });
    console.log(`[${ts()}] Curso: borrador generado (${guionBorrador.length} chars)`);

    emit('progreso', { paso: 2, mensaje: 'Humanizando y ajustando guion para audio...' });
    const plantillaHumanizacion = p.promptHumanizacion
      ? llavesDobles(p.promptHumanizacion)
      : leerPromptCurso('humanizacion.txt');
    const guion = await chat(
      renderPrompt(plantillaHumanizacion, { ...varsPrompt, guion: guionBorrador }),
      { maxTokens: 900, temperature: 0.6 }
    );
    fs.writeFileSync(rutaTxt, guion, 'utf-8');
    emit('revision_lista', { numero, guion, rutaTxt: urlCurso(`audio${numero}.txt`) });
    console.log(`[${ts()}] Curso: guion humanizado guardado en ${rutaTxt}`);

    emit('progreso', { paso: 3, mensaje: `Sintetizando audio ${idioma} (${genero})...` });
    const dirTrabajo = path.join(DIR_CURSO, `trabajo-${id}`);
    let rutaVideoCurso = null;
    try {
      const { nombreVoz, langCode } = resolverVozGoogle(idioma, genero);
      const audio = await generarAudioLargo([{ titulo: tema, texto: guion }], rutaMp3, {
        formato: 'monologo', genero, tts: 'google', idioma, dirTrabajo,
      });
      emit('audio_listo', { numero, rutaMp3: urlCurso(`audio${numero}.mp3`), nombreVoz, langCode });
      console.log(`[${ts()}] Curso: audio guardado en ${rutaMp3}`);

      if (modo === 'video') {
        const escenas = agruparEscenas(audio.segmentos, audio.duracionTotal / p.cantidadImagenes, audio.duracionTotal);
        emit('progreso', { paso: 4, mensaje: `Director de arte: guía de estilo y prompts para ${escenas.length} escena(s)...` });
        const guia = await dirigirArte(escenas, {
          titulo: tema, tema, idioma, nivel, formato: 'monologo', secciones: [{ titulo: tema }],
        });

        emit('progreso', { paso: 4, mensaje: `Generando ${escenas.length} imagen(es) con ${p.apiImagen}...` });
        console.log(`[${ts()}] Curso: iniciando imágenes api=${p.apiImagen} modelo=${p.modeloImagen} escenas=${escenas.length}`);
        await generarImagenesEscenas(escenas, guia, {
          apiImagen: p.apiImagen, modeloImagen: p.modeloImagen, dir: path.join(DIR_CURSO, `video${numero}-img`), orientacion: 'vertical', calidad: 'high',
        }, (hechos, total) => {
          emit('imagen_lista', { n: hechos, total });
          console.log(`[${ts()}] Curso: imagen ${hechos}/${total} lista.`);
        });

        emit('progreso', { paso: 5, mensaje: 'Renderizando video con FFmpeg...' });
        rutaVideoCurso = path.join(DIR_CURSO, `video${numero}.mp4`);
        const rutaAss = path.join(dirTrabajo, 'textos.ass');
        const conTexto = escribirAss(escenas, rutaAss, 'vertical');
        const { ancho, alto } = FORMATOS.vertical;
        await generarVideoEscenas(rutaMp3, escenas, rutaVideoCurso, {
          rutaAss: conTexto ? rutaAss : null, dirTrabajo, ancho, alto,
        });

        emit('video_listo', { numero, video: urlCurso(`video${numero}.mp4`) });
        console.log(`[${ts()}] Curso: video guardado en ${rutaVideoCurso}`);
      }
    } finally {
      fs.rm(dirTrabajo, { recursive: true, force: true }, () => {});
    }

    let youtubeResult = null;
    if (youtube.subirYoutube && rutaVideoCurso) {
      try {
        emit('progreso', { paso: 6, mensaje: 'Generando título y descripción para YouTube...' });
        const meta = await yt.generarMetadatosYoutube(tema, guion, idioma, nivel);
        emit('youtube_metadatos', { titulo: meta.titulo, descripcion: meta.descripcion, tags: meta.tags });
        console.log(`[${ts()}] YouTube: metadatos listos → "${meta.titulo}"`);

        emit('youtube_subiendo', {});
        console.log(`[${ts()}] YouTube: subiendo video al canal "${youtube.canalYoutube}"...`);
        youtubeResult = await yt.subirVideo({
          rutaVideo:   rutaVideoCurso,
          titulo:      meta.titulo,
          descripcion: meta.descripcion,
          tags:        meta.tags,
          canal:       youtube.canalYoutube,
          privacidad:  youtube.privacidadYoutube,
          publicarEn:  youtube.publicarYoutubeEn,
        });
        emit('youtube_listo', { url: youtubeResult.url, videoId: youtubeResult.videoId });
        console.log(`[${ts()}] YouTube: video publicado → ${youtubeResult.url}`);
      } catch (errYT) {
        // Not fatal: the video is already generated locally
        console.error(`[curso/generar] YouTube ERROR:`, errYT.message);
        emit('youtube_error', { mensaje: errYT.message });
      }
    }

    const resultado = {
      numero,
      guion,
      mp3: urlCurso(`audio${numero}.mp3`),
      txt: urlCurso(`audio${numero}.txt`),
      ...(rutaVideoCurso ? { video: urlCurso(`video${numero}.mp4`) } : {}),
      ...(youtubeResult  ? { youtubeUrl: youtubeResult.url }        : {}),
    };
    try {
      guardarEntrada({
        tipo: 'curso',
        id,
        tema,
        numero,
        idioma,
        nivel,
        modo,
        fecha: new Date().toISOString(),
        rutas: {
          audio: resultado.mp3,
          txt:   resultado.txt,
          ...(resultado.video ? { video: resultado.video } : {}),
        },
        ...(youtubeResult ? { youtubeUrl: youtubeResult.url } : {}),
      });
    } catch (errHist) {
      console.error(`[${ts()}] Curso: no se pudo guardar el historial: ${errHist.message}`);
    }
    emit('finalizado', resultado);
    console.log(`[${ts()}] Curso: audio${numero} completado (${idioma}, modo=${modo}).`);
    return resultado;
  } catch (err) {
    const mensaje = err?.response?.data ? JSON.stringify(err.response.data) : (err?.message || String(err));
    console.error(`[curso/generar] ERROR:`, mensaje);
    console.error(err?.stack || err);
    // Release the reserved number if the script was never written
    if (rutaTxt) try { if (fs.statSync(rutaTxt).size === 0) fs.unlinkSync(rutaTxt); } catch {}
    emit('pipeline_error', { mensaje });
    throw err;
  }
}

/** Same as ejecutarSinCola but waits for a slot in the global pipeline queue. */
const ejecutar = (p, emit) => cola.ejecutar(p.id, emit, () => ejecutarSinCola(p, emit));

module.exports = { ejecutar, listarArchivos };
