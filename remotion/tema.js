import { interpolate, spring } from 'remotion';

export const C = {
  fondo: '#0B1220',
  panel: 'rgba(11, 18, 32, 0.9)',
  borde: 'rgba(255, 255, 255, 0.08)',
  texto: '#FFFFFF',
  suave: '#AEBBD0',
  acento: '#FFC845',
  turquesa: '#34D3BF',
  violeta: '#A78BFA',
  coral: '#FF7A7A',
  vozF: '#FF8FB1',
  vozM: '#6CC3FF',
};

export const MARGEN = 96;
export const FUENTE = 'Inter, system-ui, sans-serif';

/** Enter (spring) / exit (fade) envelope for an overlay visible in [inicio, fin] seconds. */
export function envolvente(t, inicio, fin, fps, salida = 0.35) {
  const entrada = spring({ frame: Math.max(0, (t - inicio) * fps), fps, config: { damping: 18, stiffness: 120, mass: 0.8 } });
  const fuera = interpolate(t, [fin - salida, fin], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return { entrada, opacidad: Math.min(entrada, fuera) };
}

/** Item active at time t in a list sorted by inicio (binary search). */
export function activo(lista, t) {
  let lo = 0;
  let hi = lista.length - 1;
  let res = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (lista[m].inicio <= t) { res = m; lo = m + 1; } else hi = m - 1;
  }
  return res >= 0 && t < lista[res].fin ? lista[res] : null;
}
