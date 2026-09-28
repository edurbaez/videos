/**
 * Shared API-key support for every page (only matters when the server runs with API_KEY).
 * - fetch: adds the "x-api-key" header to same-origin requests; on 401 asks for the key once and retries.
 * - EventSource: appends "?apiKey=" (EventSource cannot send headers; the server accepts it only on SSE routes).
 * - Cookie "apiKey" (SameSite=Strict): lets <img>/<video>/<audio> under /output and /youtube/auth links load.
 * The key is stored in localStorage of this browser only.
 */
(function () {
  const CLAVE = 'apiKey';
  const fetchOriginal = window.fetch.bind(window);
  const EventSourceOriginal = window.EventSource;

  function leer() {
    try { return localStorage.getItem(CLAVE) || ''; } catch { return ''; }
  }

  function sincronizarCookie(valor) {
    const base = `${CLAVE}=${valor ? encodeURIComponent(valor) : ''}; path=/; SameSite=Strict`;
    document.cookie = valor ? `${base}; max-age=31536000` : `${base}; max-age=0`;
  }

  function guardar(valor) {
    try {
      if (valor) localStorage.setItem(CLAVE, valor); else localStorage.removeItem(CLAVE);
    } catch {}
    sincronizarCookie(valor);
  }

  function pedirClave() {
    const valor = window.prompt('El servidor requiere una clave de acceso (API_KEY). Introdúcela:');
    if (valor === null) return '';
    guardar(valor.trim());
    return valor.trim();
  }

  const mismoOrigen = url => new URL(url, location.href).origin === location.origin;

  function conClave(init, clave) {
    const headers = new Headers((init && init.headers) || {});
    if (clave) headers.set('x-api-key', clave);
    return { ...(init || {}), headers };
  }

  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input.url;
    if (!mismoOrigen(url)) return fetchOriginal(input, init);

    const resp = await fetchOriginal(input, conClave(init, leer()));
    if (resp.status !== 401) return resp;

    const nueva = pedirClave();
    if (!nueva) return resp;
    return fetchOriginal(input, conClave(init, nueva));
  };

  if (EventSourceOriginal) {
    window.EventSource = function (url, config) {
      const clave = leer();
      let destino = url;
      if (clave && mismoOrigen(url)) {
        const u = new URL(url, location.href);
        u.searchParams.set(CLAVE, clave);
        destino = u.pathname + u.search;
      }
      return new EventSourceOriginal(destino, config);
    };
    window.EventSource.prototype = EventSourceOriginal.prototype;
    ['CONNECTING', 'OPEN', 'CLOSED'].forEach(k => { window.EventSource[k] = EventSourceOriginal[k]; });
  }

  sincronizarCookie(leer());

  window.apiKey = {
    olvidar: () => guardar(''),
    cambiar: pedirClave,
  };
})();
