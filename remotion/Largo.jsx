import React from 'react';
import { AbsoluteFill, Img, Sequence, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, MARGEN, FUENTE, envolvente, activo } from './tema';
import { Tarjeta } from './Tarjetas';

const TRANSICION = 0.8;
const ZOOM = 0.12;
// Same six moves as the FFmpeg renderer (x/y: crop position inside the free margin, 0 = left/top)
const MOVIMIENTOS = [
  { z: [1, 1 + ZOOM], x: [0.5, 0.5], y: [0.5, 0.5] },
  { z: [1 + ZOOM * 0.8, 1 + ZOOM * 0.8], x: [0, 1], y: [0.4, 0.4] },
  { z: [1 + ZOOM, 1], x: [0.5, 0.5], y: [0.3, 0.5] },
  { z: [1 + ZOOM * 0.8, 1 + ZOOM * 0.8], x: [1, 0], y: [0.5, 0.5] },
  { z: [1, 1 + ZOOM], x: [0.5, 0.3], y: [0.5, 0.3] },
  { z: [1 + ZOOM, 1], x: [0.7, 0.5], y: [0.3, 0.5] },
];
const lerp = ([a, b], p) => a + (b - a) * p;

const Escena = ({ src, mov, largo, primera, ancho, alto }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = Math.min(1, frame / Math.max(1, largo - 1));
  const m = MOVIMIENTOS[mov % MOVIMIENTOS.length];
  const z = lerp(m.z, p);
  const tx = (0.5 - lerp(m.x, p)) * (z - 1) * ancho;
  const ty = (0.5 - lerp(m.y, p)) * (z - 1) * alto;
  const opacity = primera ? 1 : interpolate(frame, [0, TRANSICION * fps], [0, 1], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ opacity }}>
      <Img src={src} style={{ width: '100%', height: '100%', objectFit: 'cover', transform: `translate(${tx}px, ${ty}px) scale(${z})` }} />
    </AbsoluteFill>
  );
};

const Fondo = ({ escenas, baseImagenes, fps, ancho, alto, total }) => (
  <AbsoluteFill style={{ backgroundColor: C.fondo }}>
    {escenas.map((e, i) => {
      if (!e.archivo) return null;
      const desde = i === 0 ? 0 : Math.max(0, Math.round((e.inicio - TRANSICION / 2) * fps));
      const hasta = Math.min(total, Math.round((e.fin + TRANSICION / 2) * fps));
      if (hasta <= desde) return null;
      return (
        <Sequence key={i} from={desde} durationInFrames={hasta - desde} layout="none">
          <Escena src={`${baseImagenes}/${encodeURIComponent(e.archivo)}`} mov={e.mov} largo={hasta - desde} primera={i === 0} ancho={ancho} alto={alto} />
        </Sequence>
      );
    })}
    <AbsoluteFill style={{ background: 'linear-gradient(180deg, rgba(0,0,0,0.28) 0%, rgba(0,0,0,0) 22%, rgba(0,0,0,0) 58%, rgba(0,0,0,0.55) 100%)' }} />
  </AbsoluteFill>
);

const Subtitulos = ({ frases, t, fps }) => {
  const f = activo(frases, t);
  if (!f) return null;
  const opacidad = interpolate(t, [f.inicio, f.inicio + 0.12, f.fin - 0.12, f.fin], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const colorVoz = f.voz === 'F' ? C.vozF : f.voz === 'M' ? C.vozM : null;
  return (
    <div style={{ position: 'absolute', left: MARGEN, right: MARGEN, bottom: 54, display: 'flex', justifyContent: 'center', opacity: opacidad }}>
      <div style={{
        maxWidth: 1480, padding: '14px 30px 16px', borderRadius: 18, background: 'rgba(8, 12, 22, 0.78)',
        fontFamily: FUENTE, fontSize: 52, fontWeight: 600, lineHeight: 1.3, textAlign: 'center', color: C.texto,
        borderLeft: colorVoz ? `8px solid ${colorVoz}` : undefined,
      }}>
        {colorVoz ? (
          <span style={{ display: 'inline-block', marginRight: 16, padding: '0 14px', borderRadius: 10, fontSize: 32, fontWeight: 800, lineHeight: '46px', verticalAlign: 6, background: colorVoz, color: C.fondo }}>{f.voz}</span>
        ) : null}
        {f.palabras.map((w, k) => {
          const siguiente = f.palabras[k + 1]?.i ?? f.fin;
          const actual = t >= w.i && t < Math.max(w.f, Math.min(siguiente, w.f + 0.25));
          const dicha = !actual && t >= w.i;
          return (
            <span key={k} style={{ color: actual ? C.acento : dicha ? C.texto : 'rgba(255,255,255,0.62)' }}>
              {w.t}{k < f.palabras.length - 1 ? ' ' : ''}
            </span>
          );
        })}
      </div>
    </div>
  );
};

const Callout = ({ callouts, t, fps }) => {
  const c = activo(callouts, t);
  if (!c) return null;
  const { entrada, opacidad } = envolvente(t, c.inicio, c.fin, fps);
  return (
    <div style={{
      position: 'absolute', left: MARGEN, top: 64, maxWidth: 860, opacity: opacidad,
      transform: `translateX(${(1 - entrada) * -40}px)`, display: 'flex', alignItems: 'stretch',
      background: C.panel, borderRadius: 16, overflow: 'hidden', fontFamily: FUENTE,
    }}>
      <div style={{ width: 10, background: C.acento, flexShrink: 0 }} />
      <div style={{ padding: '16px 26px 18px', fontSize: 40, fontWeight: 700, lineHeight: 1.25, color: C.texto }}>{c.texto}</div>
    </div>
  );
};

const TituloIntro = ({ titulo, subtitulo, intro, t, fps }) => {
  if (t >= intro.fin) return null;
  const { entrada, opacidad } = envolvente(t, 0, intro.fin, fps, 0.6);
  return (
    <AbsoluteFill style={{ opacity: opacidad, background: 'linear-gradient(135deg, rgba(11,18,32,0.94) 0%, rgba(11,18,32,0.78) 100%)', justifyContent: 'center', alignItems: 'center', fontFamily: FUENTE }}>
      <div style={{ maxWidth: 1500, textAlign: 'center', transform: `translateY(${(1 - entrada) * 30}px)` }}>
        <div style={{ fontSize: 88, fontWeight: 800, lineHeight: 1.12, color: C.texto, letterSpacing: -1.5 }}>{titulo}</div>
        <div style={{ width: 160 * entrada, height: 8, borderRadius: 4, background: C.acento, margin: '40px auto 30px' }} />
        {subtitulo ? <div style={{ fontSize: 38, fontWeight: 500, color: C.suave }}>{subtitulo}</div> : null}
      </div>
    </AbsoluteFill>
  );
};

const TituloCapitulo = ({ capitulos, etiqueta, t, fps }) => {
  const c = capitulos.slice(1).find(x => t >= x.inicio && t < x.inicio + 3);
  if (!c) return null;
  const fin = c.inicio + 3;
  const { entrada, opacidad } = envolvente(t, c.inicio, fin, fps, 0.45);
  return (
    <AbsoluteFill style={{ opacity: opacidad, background: 'linear-gradient(90deg, rgba(11,18,32,0.9) 0%, rgba(11,18,32,0.55) 55%, rgba(11,18,32,0) 85%)', justifyContent: 'center', fontFamily: FUENTE }}>
      <div style={{ marginLeft: MARGEN + 24, maxWidth: 1100, transform: `translateX(${(1 - entrada) * -60}px)`, marginTop: -60 }}>
        <div style={{ fontSize: 34, fontWeight: 800, color: C.acento, letterSpacing: 6, textTransform: 'uppercase' }}>
          {etiqueta} {String(c.n).padStart(2, '0')}
        </div>
        <div style={{ fontSize: 80, fontWeight: 800, lineHeight: 1.1, color: C.texto, marginTop: 18, letterSpacing: -1 }}>{c.titulo}</div>
      </div>
    </AbsoluteFill>
  );
};

const Progreso = ({ t, duracion, capitulos }) => (
  <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 8, background: 'rgba(255,255,255,0.16)' }}>
    <div style={{ width: `${Math.min(100, (t / duracion) * 100)}%`, height: '100%', background: C.acento }} />
    {capitulos.slice(1).map(c => (
      <div key={c.n} style={{ position: 'absolute', left: `${(c.inicio / duracion) * 100}%`, top: -6, width: 4, height: 14, borderRadius: 2, background: C.texto }} />
    ))}
  </div>
);

export const Largo = (props) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();
  const t = frame / fps;
  const { escenas, frases, callouts, tarjetas, capitulos, intro, titulo, etiquetas, duracion, baseImagenes } = props;
  const tarjeta = activo(tarjetas, t);
  const primer = capitulos[0];
  return (
    <AbsoluteFill style={{ backgroundColor: C.fondo, fontFamily: FUENTE }}>
      <Fondo escenas={escenas} baseImagenes={baseImagenes} fps={fps} ancho={width} alto={height} total={durationInFrames} />
      <Callout callouts={callouts} t={t} fps={fps} />
      {tarjeta ? <Tarjeta tarjeta={tarjeta} etiquetas={etiquetas} t={t} fps={fps} /> : null}
      <TituloCapitulo capitulos={capitulos} etiqueta={etiquetas.capitulo || ''} t={t} fps={fps} />
      <TituloIntro titulo={titulo} subtitulo={primer ? `${primer.n} · ${primer.titulo}` : ''} intro={intro} t={t} fps={fps} />
      <Subtitulos frases={frases} t={t} fps={fps} />
      <Progreso t={t} duracion={duracion} capitulos={capitulos} />
    </AbsoluteFill>
  );
};
