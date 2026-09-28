const seg = require('../middleware/seguridad');
const yt = require('../services/youtube');

const PRIVACIDADES = ['public', 'unlisted', 'private'];

class ErrorValidacion extends Error {}

/**
 * Validates the shared YouTube options of a generation request.
 * Upload only applies when `modo` is undefined (shorts) or 'video'.
 * Throws ErrorValidacion (→ 400) on an invalid date or an unknown/unauthorized channel.
 * @returns {{ subirYoutube: boolean, canalYoutube: string|null, privacidadYoutube: string, publicarYoutubeEn: string|null }}
 */
function resolverOpcionesYoutube(body, modo) {
  const permiteSubida = modo === undefined || modo === 'video';
  const subirYoutube = (body.subirYoutube === true || body.subirYoutube === 'true') && permiteSubida;
  const privacidadYoutube = PRIVACIDADES.includes(body.privacidadYoutube) ? body.privacidadYoutube : 'private';

  let publicarYoutubeEn;
  try {
    publicarYoutubeEn = seg.validarFechaProgramada(body.publicarYoutubeEn);
  } catch (e) {
    throw new ErrorValidacion(e.message);
  }

  let canalYoutube = null;
  if (subirYoutube) {
    const canal = yt.listarCanalesConfig().find(c => c.nombre === body.canalYoutube);
    if (!canal) {
      throw new ErrorValidacion(`Canal YouTube "${body.canalYoutube}" no encontrado en youtube-channels.json.`);
    }
    if (!canal.autorizado) {
      throw new ErrorValidacion(`Canal "${canal.label}" no autorizado. Visita /youtube/auth?canal=${canal.nombre}`);
    }
    canalYoutube = canal.nombre;
  }

  return { subirYoutube, canalYoutube, privacidadYoutube, publicarYoutubeEn };
}

module.exports = { resolverOpcionesYoutube, ErrorValidacion };
