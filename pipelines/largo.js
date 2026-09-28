const fs = require('fs');
const path = require('path');
const { DIR_LARGO, escribirJsonAtomico, urlDeRuta } = require('../utils/archivos');
const { ts } = require('../utils/log');
const { generarGuionLargo, limpiarEtiquetas, PALABRAS_POR_MINUTO } = require('../services/guionLargo');
const { generarAudioLargo, formatearTiempo } = require('../services/audioLargo');
const { agruparEscenas, dirigirArte, generarImagenesEscenas, escribirAss } = require('../services/escenasLargo');
const { generarVideoEscenas } = require('../services/video');
const yt = require('../services/youtube');
const { cola } = require('../lib/cola');
const { guardarEntrada } = require('../utils/historial');

const MIN_MINUTOS = 3;
const MAX_MINUTOS = parseInt(process.env.LARGO_MAX_MINUTOS) || 30;
const SEG_IMAGEN_MIN = 10;
const SEG_IMAGEN_MAX = 120;
const SEGUNDOS_POR_IMAGEN = Math.min(SEG_IMAGEN_MAX, Math.max(SEG_IMAGEN_MIN, parseInt(process.env.LARGO_SEGUNDOS_POR_IMAGEN) || 30));

const LIMITES = {
  minMinutos: MIN_MINUTOS, maxMinutos: MAX_MINUTOS, palabrasPorMinuto: PALABRAS_POR_MINUTO,
  segundosPorImagen: SEGUNDOS_POR_IMAGEN, minSegundosImagen: SEG_IMAGEN_MIN, maxSegundosImagen: SEG_IMAGEN_MAX,
};

/** Metadata of the latest 50 long videos (output/largo/*.json), newest first */
function listarArchivos() {
  return fs.readdirSync(DIR_LARGO)
    .filter(f => /^largo-[0-9a-f-]+\.json$/.test(f))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(DIR_LARGO, f), 'utf-8')); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''))
    .slice(0, 50);
}

/**
 * Long video pipeline: sectioned script → chunked TTS → scenes + art direction + images → horizontal video
 * → (optional) YouTube. Resolves with the final metadata; on failure emits 'pipeline_error' and rejects.
 *
 * @param {object} p - { id, tema, idioma, nivel, formato, genero, tts, modo, palabras, minutos, segundosPorImagen,
 *                       apiImagen, modeloImagen, youtube: { subirYoutube, canalYoutube, privacidadYoutube, publicarYoutubeEn } }
 * @param {(evento: string, datos: object) => void} emit
 */
async function ejecutarSinCola(p, emit) {
  const { id, tema, idioma, nivel, formato, genero, tts, modo, minutos, segundosPorImagen, apiImagen, modeloImagen } = p;
  const youtube = p.youtube || {};
  const dirTrabajo  = path.join(DIR_LARGO, id);
  const rutaTxt     = path.join(DIR_LARGO, `${id}.txt`);
  const rutaMp3     = path.join(DIR_LARGO, `${id}.mp3`);
  const dirImg      = path.join(DIR_LARGO, `${id}-img`);
  const rutaAss     = path.join(dirTrabajo, 'textos.ass');
  const rutaEscenas = path.join(DIR_LARGO, `${id}-escenas.json`);
  const rutaMp4     = path.join(DIR_LARGO, `${id}.mp4`);
  const rutaMeta    = path.join(DIR_LARGO, `${id}.json`);

  try {
    console.log(`[${ts()}] Largo ${id}: tema="${tema}" idioma=${idioma} nivel=${nivel} formato=${formato} minutos=${minutos} tts=${tts} modo=${modo}`);

    emit('progreso', { paso: 1, mensaje: 'Diseñando el esquema de la lección...' });
    const guion = await generarGuionLargo({ tema, idioma, nivel, minutos, formato, palabras: p.palabras }, async (ev) => {
      if (ev.tipo === 'esquema') {
        emit('esquema_listo', { titulo: ev.esquema.titulo, secciones: ev.esquema.secciones.map(s => s.titulo) });
      } else {
        emit('seccion_lista', { n: ev.indice + 1, total: ev.total, titulo: ev.seccion.titulo, palabras: ev.seccion.palabras });
        console.log(`[${ts()}] Largo ${id}: sección ${ev.indice + 1}/${ev.total} (${ev.seccion.palabras} palabras)`);
      }
    });

    const textoCompleto = `${guion.titulo}\n\n` + guion.secciones.map((s, i) => `## ${i + 1}. ${s.titulo}\n\n${s.texto}`).join('\n\n');
    fs.writeFileSync(rutaTxt, textoCompleto, 'utf-8');
    emit('guion_listo', {
      titulo: guion.titulo,
      palabras: guion.palabrasTotales,
      palabrasObjetivo: guion.palabrasObjetivo,
      minutosEstimados: +(guion.palabrasTotales / PALABRAS_POR_MINUTO).toFixed(1),
      txt: urlDeRuta(rutaTxt),
    });

    const meta = {
      id, fecha: new Date().toISOString(), tema, idioma, nivel, formato, tts, minutosSolicitados: minutos,
      titulo: guion.titulo, palabras: guion.palabrasTotales, txt: urlDeRuta(rutaTxt),
    };
    const guardarMeta = () => escribirJsonAtomico(rutaMeta, meta);
    guardarMeta();

    let capitulos = [];
    let segmentos = [];
    let duracionAudio = 0;
    if (modo !== 'guion') {
      emit('progreso', { paso: 2, mensaje: `Sintetizando audio (${tts}, ${formato === 'dialogo' ? '2 voces' : 'voz ' + genero})...` });
      const audio = await generarAudioLargo(guion.secciones, rutaMp3, { formato, genero, tts, idioma, dirTrabajo }, (hechos, total) => {
        emit('audio_progreso', { hechos, total });
      });
      capitulos = audio.capitulos;
      segmentos = audio.segmentos;
      duracionAudio = audio.duracionTotal;
      meta.mp3 = urlDeRuta(rutaMp3);
      meta.duracion = Math.round(audio.duracionTotal);
      meta.capitulos = capitulos.map(c => ({ titulo: c.titulo, inicio: formatearTiempo(c.inicio) }));
      guardarMeta();
      emit('audio_listo', { mp3: meta.mp3, duracion: meta.duracion, capitulos: meta.capitulos });
      console.log(`[${ts()}] Largo ${id}: audio ${meta.duracion}s`);
    }

    if (modo === 'video') {
      const escenas = agruparEscenas(segmentos, segundosPorImagen, duracionAudio);
      emit('progreso', { paso: 3, mensaje: `Director de arte: guía de estilo y prompts para ${escenas.length} escenas (~${segundosPorImagen}s c/u)...` });
      const guia = await dirigirArte(escenas, {
        titulo: guion.titulo, tema, idioma, nivel, formato, secciones: guion.secciones,
      });
      emit('escenas_listas', { total: escenas.length, segundosPorImagen });

      emit('progreso', { paso: 4, mensaje: `Generando ${escenas.length} imágenes (${apiImagen})...` });
      await generarImagenesEscenas(escenas, guia, { apiImagen, modeloImagen, dir: dirImg }, (hechos, total) => {
        emit('imagenes_progreso', { hechos, total });
      });
      const reutilizadas = escenas.filter(e => e.imagenReutilizada).length;
      const errorImagen = escenas.find(e => e.imagenReutilizada)?.errorImagen;
      if (reutilizadas) console.warn(`[${ts()}] Largo ${id}: ${reutilizadas} escenas reutilizan imagen vecina por fallo. Último error: ${errorImagen}`);

      escribirJsonAtomico(rutaEscenas, {
        segundosPorImagen,
        guia,
        escenas: escenas.map(e => ({
          n: e.n, inicio: +e.inicio.toFixed(2), fin: +e.fin.toFixed(2), textoPantalla: e.textoPantalla,
          prompt: e.prompt, imagen: urlDeRuta(e.imagen), reutilizada: !!e.imagenReutilizada, errorImagen: e.errorImagen, texto: e.texto,
        })),
      });
      meta.png = urlDeRuta(escenas[0].imagen);
      meta.escenas = urlDeRuta(rutaEscenas);
      meta.numImagenes = escenas.length;
      emit('imagen_lista', { png: meta.png, total: escenas.length, reutilizadas, errorImagen });

      emit('progreso', { paso: 5, mensaje: 'Renderizando video 1920×1080...' });
      const conTexto = escribirAss(escenas, rutaAss);
      await generarVideoEscenas(rutaMp3, escenas, rutaMp4, { rutaAss: conTexto ? rutaAss : null, dirTrabajo });
      meta.video = urlDeRuta(rutaMp4);
      guardarMeta();
      emit('video_listo', { video: meta.video });
    }

    if (youtube.subirYoutube) {
      try {
        emit('progreso', { paso: 6, mensaje: 'Generando metadatos y subiendo a YouTube...' });
        const textoPlano = limpiarEtiquetas(guion.secciones.map(s => s.texto).join('\n'));
        const ytMeta = await yt.generarMetadatosYoutube(tema, textoPlano, idioma, nivel, { esShort: false });
        // YouTube rejects '<' and '>' in title and description
        const capitulosTxt = capitulos.map(c => `${formatearTiempo(c.inicio)} ${c.titulo}`).join('\n');
        const resultado = await yt.subirVideo({
          rutaVideo: rutaMp4,
          titulo: ytMeta.titulo.replace(/[<>]/g, '').slice(0, 100),
          descripcion: `${ytMeta.descripcion}\n\n${capitulosTxt}`.replace(/[<>]/g, '').slice(0, 4900),
          tags: ytMeta.tags,
          canal: youtube.canalYoutube,
          privacidad: youtube.privacidadYoutube,
          publicarEn: youtube.publicarYoutubeEn,
        });
        meta.youtubeUrl = resultado.url;
        guardarMeta();
        emit('youtube_listo', { url: resultado.url });
      } catch (errYT) {
        console.error(`[largo/generar] YouTube ERROR:`, errYT.message);
        emit('youtube_error', { mensaje: errYT.message });
      }
    }

    try {
      guardarEntrada({
        tipo: 'largo',
        id,
        tema,
        titulo: meta.titulo,
        idioma,
        nivel,
        formato,
        modo,
        fecha: meta.fecha,
        rutas: {
          txt: meta.txt,
          ...(meta.mp3 ? { audio: meta.mp3 } : {}),
          ...(meta.video ? { video: meta.video } : {}),
        },
        ...(meta.youtubeUrl ? { youtubeUrl: meta.youtubeUrl } : {}),
      });
    } catch (errHist) {
      console.error(`[${ts()}] Largo ${id}: no se pudo guardar el historial: ${errHist.message}`);
    }
    emit('finalizado', meta);
    console.log(`[${ts()}] Largo ${id}: completado.`);
    return meta;
  } catch (err) {
    const mensaje = err?.response?.data ? JSON.stringify(err.response.data) : (err?.message || String(err));
    console.error(`[largo/generar] ERROR:`, mensaje);
    emit('pipeline_error', { mensaje });
    throw err;
  } finally {
    fs.rm(dirTrabajo, { recursive: true, force: true }, () => {});
  }
}

/** Same as ejecutarSinCola but waits for a slot in the global pipeline queue. */
const ejecutar = (p, emit) => cola.ejecutar(p.id, emit, () => ejecutarSinCola(p, emit));

module.exports = { ejecutar, listarArchivos, LIMITES };
