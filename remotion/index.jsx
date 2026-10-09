import React from 'react';
import { Composition, registerRoot, delayRender, continueRender, cancelRender, staticFile } from 'remotion';
import { Largo } from './Largo';

// Bundled locally (Inter, OFL) so renders work offline; latin + latin-ext cover de/fr/es/pt/en diacritics.
const FUENTES = [
  ['inter-latin-wght-normal.woff2', 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'],
  ['inter-latin-ext-wght-normal.woff2', 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF'],
];
const esperaFuentes = delayRender('fuentes');
Promise.all(FUENTES.map(([archivo, rango]) => {
  const fuente = new FontFace('Inter', `url(${staticFile(`fonts/${archivo}`)}) format('woff2')`, { weight: '100 900', unicodeRange: rango });
  document.fonts.add(fuente);
  return fuente.load();
})).then(() => continueRender(esperaFuentes)).catch(err => cancelRender(err));

const PROPS_VACIAS = {
  fps: 25, ancho: 1920, alto: 1080, duracion: 5, duracionFrames: 125, titulo: '', etiquetas: {}, dialogo: false,
  intro: { inicio: 0, fin: 4.5 }, capitulos: [], escenas: [], frases: [], callouts: [], tarjetas: [], baseImagenes: '',
};

const Raiz = () => (
  <Composition
    id="Largo"
    component={Largo}
    width={1920}
    height={1080}
    fps={25}
    durationInFrames={125}
    defaultProps={PROPS_VACIAS}
    calculateMetadata={({ props }) => ({
      durationInFrames: props.duracionFrames, fps: props.fps, width: props.ancho, height: props.alto,
    })}
  />
);

registerRoot(Raiz);
