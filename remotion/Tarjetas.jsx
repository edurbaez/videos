import React from 'react';
import { interpolate } from 'remotion';
import { C, MARGEN, FUENTE, envolvente } from './tema';

const ANCHO = 740;
const COLOR = { ejemplo: C.acento, tabla: C.turquesa, puntos: C.violeta, quiz: C.coral };
const LETRAS = ['A', 'B', 'C', 'D'];

const aparecer = (t, desde) => interpolate(t, [desde, desde + 0.35], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

const Check = () => (
  <svg width="34" height="34" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
    <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke={C.fondo} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const Ejemplo = ({ tarjeta }) => (
  <>
    <div style={{ fontSize: tarjeta.texto.length > 80 ? 40 : 48, fontWeight: 700, lineHeight: 1.22, color: C.texto }}>{tarjeta.texto}</div>
    {tarjeta.traduccion ? (
      <div style={{ marginTop: 22, paddingTop: 20, borderTop: `2px solid ${C.borde}`, fontSize: 32, fontWeight: 500, lineHeight: 1.3, color: C.suave }}>
        {tarjeta.traduccion}
      </div>
    ) : null}
  </>
);

const Tabla = ({ tarjeta, t }) => {
  const filas = tarjeta.filas.length;
  const fuente = filas > 5 || tarjeta.columnas.length > 3 ? 25 : 29;
  const pad = filas > 5 ? '9px 14px' : '13px 16px';
  return (
    <>
      {tarjeta.titulo ? <div style={{ fontSize: 38, fontWeight: 800, lineHeight: 1.2, color: C.texto, marginBottom: 18 }}>{tarjeta.titulo}</div> : null}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: fuente, lineHeight: 1.25 }}>
        <thead>
          <tr>
            {tarjeta.columnas.map((c, k) => (
              <th key={k} style={{ textAlign: 'left', padding: pad, color: C.turquesa, fontWeight: 800, borderBottom: `3px solid ${C.turquesa}`, overflowWrap: 'break-word' }}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tarjeta.filas.map((f, r) => {
            const o = aparecer(t, tarjeta.inicio + 0.5 + r * 0.3);
            return (
              <tr key={r} style={{ opacity: o, transform: `translateY(${(1 - o) * 12}px)`, background: r % 2 ? 'rgba(255,255,255,0.04)' : 'transparent' }}>
                {f.map((c, k) => (
                  <td key={k} style={{ padding: pad, color: k === 0 ? C.texto : '#E3E9F3', fontWeight: k === 0 ? 700 : 500, borderBottom: `1px solid ${C.borde}`, overflowWrap: 'break-word', verticalAlign: 'top' }}>{c}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
};

const Puntos = ({ tarjeta, t }) => {
  const paso = Math.min(1.2, (tarjeta.fin - tarjeta.inicio - 2) / Math.max(1, tarjeta.puntos.length));
  return (
    <>
      <div style={{ fontSize: 30, fontWeight: 600, color: C.suave, marginBottom: 20, lineHeight: 1.25 }}>{tarjeta.titulo}</div>
      {tarjeta.puntos.map((p, k) => {
        const o = aparecer(t, tarjeta.inicio + 0.4 + k * paso);
        return (
          <div key={k} style={{ display: 'flex', alignItems: 'flex-start', gap: 20, marginTop: k ? 18 : 0, opacity: o, transform: `translateX(${(1 - o) * 24}px)` }}>
            <div style={{ flexShrink: 0, width: 48, height: 48, borderRadius: 24, background: C.violeta, color: C.fondo, fontSize: 28, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{k + 1}</div>
            <div style={{ fontSize: 36, fontWeight: 600, lineHeight: 1.25, color: C.texto, paddingTop: 2 }}>{p}</div>
          </div>
        );
      })}
    </>
  );
};

const Quiz = ({ tarjeta, t }) => {
  const revelado = t >= tarjeta.revelar;
  return (
    <>
      <div style={{ fontSize: 38, fontWeight: 700, lineHeight: 1.25, color: C.texto, marginBottom: 24 }}>{tarjeta.pregunta}</div>
      {tarjeta.opciones.map((o, k) => {
        const correcta = k === tarjeta.correcta;
        const fondo = revelado && correcta ? C.turquesa : 'rgba(255,255,255,0.07)';
        return (
          <div key={k} style={{
            display: 'flex', alignItems: 'center', gap: 18, marginTop: k ? 12 : 0, padding: '14px 18px', borderRadius: 14,
            background: fondo, opacity: revelado && !correcta ? 0.45 : aparecer(t, tarjeta.inicio + 0.4 + k * 0.25),
          }}>
            <div style={{ flexShrink: 0, width: 46, height: 46, borderRadius: 12, background: revelado && correcta ? C.texto : C.coral, color: C.fondo, fontSize: 26, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{LETRAS[k]}</div>
            <div style={{ flex: 1, fontSize: 34, fontWeight: 600, lineHeight: 1.25, color: revelado && correcta ? C.fondo : C.texto }}>{o}</div>
            {revelado && correcta ? <Check /> : null}
          </div>
        );
      })}
    </>
  );
};

const CUERPOS = { ejemplo: Ejemplo, tabla: Tabla, puntos: Puntos, quiz: Quiz };

/** Side panel on the right; captions keep the bottom band, callouts the top-left corner. */
export const Tarjeta = ({ tarjeta, etiquetas, t, fps }) => {
  const Cuerpo = CUERPOS[tarjeta.tipo];
  if (!Cuerpo) return null;
  const { entrada, opacidad } = envolvente(t, tarjeta.inicio, tarjeta.fin, fps);
  const color = COLOR[tarjeta.tipo];
  return (
    <div style={{
      position: 'absolute', right: MARGEN, top: 64, width: ANCHO, maxHeight: 780, overflow: 'hidden',
      opacity: opacidad, transform: `translateX(${(1 - entrada) * 80}px)`,
      background: C.panel, borderRadius: 24, border: `1px solid ${C.borde}`, borderTop: `8px solid ${color}`,
      padding: '26px 36px 34px', fontFamily: FUENTE, boxShadow: '0 18px 50px rgba(0,0,0,0.35)',
    }}>
      <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: 4, textTransform: 'uppercase', color, marginBottom: 18 }}>{etiquetas[tarjeta.tipo] || ''}</div>
      <Cuerpo tarjeta={tarjeta} t={t} />
    </div>
  );
};
