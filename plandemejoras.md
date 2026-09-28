# Plan de mejoras

Revisión del 2026-09-28 sobre `server.js`, `services/`, `utils/`, `middleware/` y `nichos/`.

---

## 1. Revisión de `sugerencias.md` (automatización diaria)

**Veredicto:** se puede implementar sin romper nada si se agrega como módulos nuevos. **Tal como está escrito no funciona**: el primer video fallaría o saldría con otra configuración.

| # | Qué dice la sugerencia | Qué pasa realmente | Corrección |
|---|---|---|---|
| 1 | "Añadir parámetro `privacidad: 'unlisted'`" | **Ya existe**, pero se llama `privacidadYoutube` ([server.js:232](server.js#L232)). Si se envía `privacidad`, se ignora y el video se sube como `private`. | Enviar `privacidadYoutube`. El Paso 1 no hace falta. |
| 2 | `POST /generar { subirYoutube: true }` | Falta `canalYoutube`: la API responde **400** ([server.js:243-246](server.js#L243-L246)). | Agregar la columna `canal` al CSV o `youtube.canal` en el `config.json` de cada nicho. |
| 3 | "Nada del pipeline necesita modificarse" | `POST /generar` responde con `{id}` antes de generar nada. El scheduler marca la idea como usada **aunque el pipeline falle** y nunca se entera del resultado. Sin cliente SSE, `emitirEvento` descarta los eventos. | Mover el pipeline a una función (`pipelines/short.js`, ver §3.1) que devuelva una promesa, y llamarla **en el mismo proceso** desde el scheduler. Marcar la idea como usada solo si termina bien y avisar a Telegram si falla. |
| 4 | Llamada HTTP a `localhost:3000` | Si `API_KEY` está definida hace falta el header `x-api-key`. El puerto está fijo en el código. | Se resuelve con el punto 3 (sin HTTP). |
| 5 | `google-trends-api` como fuente principal | Paquete sin mantenimiento desde 2020 que usa un endpoint no oficial. Suele devolver 429 o HTML, y entonces `JSON.parse` lanza error. | Usar como **principal** el RSS de Google News (opción C) y Trends solo como extra dentro de try/catch. Para el RSS, `fast-xml-parser` es más liviano que `xml2js`. |
| 6 | Opción B "ya activa" | `videos.list?chart=mostPopular` funciona con el OAuth del canal (scope `youtube.readonly`), pero gasta cuota del canal. | Aceptable como fallback, con caché diaria. |
| 7 | Tema = `idea + titular de tendencia` | El titular es texto externo que entra en los prompts de GPT y en el título de YouTube (prompt injection). En los nichos `salud_*` también hay riesgo de desinformación. | Limpiar y acortar el titular (≤120 caracteres), pedir a GPT que solo lo use como "contexto opcional", y **desactivar las tendencias en `salud_*`**. |
| 8 | `ideas.csv` reescrito por el scheduler | En Windows, si el CSV está abierto en Excel la escritura falla con `EBUSY`. Una escritura no atómica puede corromper el archivo. | Guardar el estado en `ideas-estado.json` (escritura temporal + `rename`) y dejar el CSV solo para lectura. Otra opción es reintentar ante `EBUSY`. |
| 9 | `node-cron` dentro del servidor | Si el servidor está apagado a las 09:00, ese día no se genera nada. `npm run dev` (`--watch`) lo reinicia en cada cambio. | Guardar `ultimaEjecucion` y recuperar la ejecución perdida al arrancar. Alternativa: Programador de tareas de Windows con un script independiente. |
| 10 | Sin límite de concurrencia | Si coincide con una generación manual, compiten por la cuota de imágenes y por FFmpeg. | Cola global de pipelines (§3.4). |

**Orden recomendado para implementarlo:** §3.1 (extraer el pipeline) → §3.4 (cola) → `services/ideas.js` → `services/tendencias.js` (primero RSS) → `scheduler.js` en el mismo proceso, con `timezone` y recuperación de ejecuciones perdidas.

---

## 2. P0: bugs y seguridad (hacer primero)

1. **OAuth callback sin validar `state`** ([server.js:1137-1152](server.js#L1137-L1152), [youtube.js:41-44](services/youtube.js#L41-L44)). Hay tres problemas:
   - **XSS reflejado**: `state` se inserta sin escapar en el HTML de respuesta.
   - **Path traversal**: `tokenPath(state)` escribe `youtube-tokens-${state}.json` con cualquier valor, por ejemplo `../../x`.
   - **OAuth CSRF**: cualquiera puede asociar su propia cuenta de Google a un canal.

   Solución: generar un `state` aleatorio (`crypto.randomUUID()`), guardarlo en un `Map` como `state → canal` con un TTL de 10 min, validar que el canal esté en `youtube-channels.json` y escapar el HTML.
2. **`gpt-image-1` se retira el 23-oct-2026 (en 25 días).** Sigue siendo el default en [server.js:263](server.js#L263), [server.js:640](server.js#L640), [imagenes.js:77,118,444](services/imagenes.js#L77) y en la whitelist de curso y largo ([server.js:723](server.js#L723), [server.js:949](server.js#L949)). Los nichos ya usan `gpt-image-2`. Cambiar los defaults a `gpt-image-2` o `gpt-image-1-mini` y centralizar la lista de modelos en un solo sitio (§3.3).
3. **Los defaults del nicho se ignoran** en `/generar`, lo que contradice la convención de CLAUDE.md:
   - `api = 'openai'` en el destructuring ([server.js:198](server.js#L198)) impide que se use `defaults.apiImagen`.
   - `validarCantidad(req.body.cantidad)` devuelve 1 si no llega el valor, así que `defaults.cantidadImagenes` nunca se aplica ([server.js:209](server.js#L209)).
4. **Carrera en `/curso/generar`**: `cursosiguienteNumero()` ([server.js:772](server.js#L772)) calcula el número sin reservarlo. Dos peticiones simultáneas reciben el mismo número y se sobrescriben entre sí. Reservarlo creando el `.txt` con `fs.openSync(..., 'wx')` en un bucle.
5. **El modo `API_KEY` es incompatible con el propio frontend**: `EventSource` no envía headers, ningún HTML manda `x-api-key` y el callback de Google tampoco lo trae. Activar `API_KEY` rompe toda la app. Soluciones:
   - Excluir `/youtube/callback` (ya queda protegido por el `state` del punto 1).
   - Hacer que el frontend guarde la clave y la envíe (header en `fetch`, `?apiKey=` en SSE), o pasar a una cookie de sesión.
   - Comparar la clave con `crypto.timingSafeEqual`.
6. **Subtítulos con idioma fijo `'es'`** ([subtitulos.js:20](services/subtitulos.js#L20)): usar `nichoConfig.idioma`.
7. **Sin timeouts en axios**: un proveedor colgado deja el pipeline y la conexión SSE abiertos para siempre. Poner `timeout` por defecto (60–120 s para chat, 180 s para imágenes y uploads).
8. **El token de Telegram aparece en los logs** ([telegram.js:55](services/telegram.js#L55)). Quitar el prefijo del token del log.
9. **Caption de `sendVideo` > 1024 caracteres** ([telegram.js:34](services/telegram.js#L34)): Telegram rechaza el video entero. Recortar a 1024; el caption completo ya se envía antes como texto.

---

## 3. Estructura

### 3.1 Partir `server.js` (1185 líneas)
```
routes/        shorts.js, util.js, curso.js, largo.js, youtube.js   (solo validación + res.json)
pipelines/     short.js, curso.js, largo.js                          (lógica async, reciben emit())
lib/sse.js     canal SSE reutilizable
```
Cada pipeline exporta `ejecutar(params, emit) → Promise<resultado>`. Esto es lo que necesitan tanto el scheduler como una futura cola.

### 3.2 Eliminar duplicación

| Duplicado | Veces | Destino |
|---|---|---|
| Endpoint SSE + `emit` | 5 | `lib/sse.js` → `crearCanal(nombre)` con `{ ruta, emit }` |
| Validación de canal de YouTube + privacidad + fecha | 3 | `resolverOpcionesYoutube(body, modo)` |
| Llamada a OpenAI chat con headers | 8 archivos | `services/openai.js` → `chat({ model, prompt, json, maxTokens })` con timeout y reintento ante 429/5xx |
| `new GoogleAuth()` en cada llamada | 2 | Singleton en `services/googleAuth.js` |
| `ejecutarConLimite` | 2 | `utils/concurrencia.js` |
| `LANG_NAMES`, lista de idiomas, niveles, modelos de imagen | 4+ | `utils/constantes.js` (lo que ya está en `seguridad.js` debe ser la fuente única) |
| `const ts = () => ...` | ~20 | `utils/log.js` |
| `require('dotenv').config()` en cada servicio | 8 | Solo en `server.js` |

### 3.3 Texto de dominio en el código (contradice el diseño de nichos)
- [youtube.js:211-258](services/youtube.js#L211-L258) `generarMetadatosShorts`: tiene fijos "Spanish", "motivational tone" y `categoryId: '27'` (Education) para todos los nichos. Hay que mover esos prompts a `nichos/<id>/prompt-youtube-*.txt` y añadir `youtube.categoria` e `idioma` al `config.json`.
- `generarMetadatosYoutube` fija las secciones 🇩🇪/🇪🇸. Moverlo a `prompts/curso/`.
- [guionLargo.js:58-115](services/guionLargo.js#L58-L115) tiene los prompts escritos en el código. Moverlos a `prompts/largo/`, igual que ya se hizo con el director de arte.
- [imagenes.js:405-413](services/imagenes.js#L405-L413) `generarTodosPrompts`: el prompt está en el código y el fallback es "motivational".
- `/util/guion` y `/util/imagenes` usan siempre el nicho `motivacion` ([server.js:457](server.js#L457), [server.js:505](server.js#L505)). Aceptar `nicho` desde el request.

### 3.4 Cola de pipelines
No hay límite de pipelines simultáneos. Varias generaciones a la vez compiten por la cuota de imágenes (429) y por CPU (FFmpeg). Añadir una cola en memoria con `MAX_PIPELINES` (default 1–2) y un evento SSE `en_cola { posicion }`. Es requisito para el scheduler.

### 3.5 Firmas de funciones
`generarImagenes` tiene 13 parámetros posicionales ([imagenes.js:296](services/imagenes.js#L296)) y `generarImagenesSecuencial` tiene 11. Pasarlas a un objeto de opciones. Hoy añadir un parámetro obliga a tocar todos los call sites y es fácil desordenarlos.

### 3.6 Código muerto
`enviarFotos` (se importa y no se usa), `rutaReferencia` y el import de `resolverVozGoogle` más allá de su uso para el log. Revisar y eliminar.

---

## 4. Flujo de datos

1. **Eventos SSE perdidos**: el cliente abre el SSE *después* de recibir `{id}`. Todo lo que se emite antes se pierde, por ejemplo un error inmediato de nicho o de OpenAI. Solución: que `lib/sse.js` guarde un buffer de eventos por id y lo reenvíe al conectar. Borrar el buffer 10 min después de `finalizado`.
2. **Nombres de eventos inconsistentes**: `error_pipeline` (shorts), `pipeline_error` (curso y largo), `error` (util). Unificarlos y mantener alias durante una versión para no romper el frontend.
3. **URLs construidas a mano** en muchos sitios (`/output/imagenes/imagen-${id}-${i+1}.png`, etc.). Añadir `urlAudio(id)`, `urlImagen(id, n)`… en `utils/archivos.js`, junto a las funciones de ruta.
4. **El historial asume que todas las imágenes existen** ([server.js:408](server.js#L408)). Usar las rutas reales devueltas por `generarImagenes`, y marcar los placeholders y el resultado de YouTube (`youtubeUrl`).
5. **Tres historiales distintos**: `historial.json` (shorts), `output/curso/*` detectado por nombre de archivo y `output/largo/*.json`. A medio plazo, un único `utils/historial.js` con `tipo: 'short' | 'curso' | 'largo'`.
6. **Escritura no atómica de `historial.json`** ([historial.js:32](utils/historial.js#L32)). Si el proceso se cae a mitad de escritura, `leerHistorial` devuelve `[]` y la siguiente escritura borra todo el historial. Escribir en `.tmp` y hacer `rename`.

---

## 5. Eficiencia de recursos

| Problema | Dónde | Mejora |
|---|---|---|
| Se crea un `GoogleAuth` y se pide un token nuevo en **cada** TTS o imagen. En un video largo son decenas de piezas. | [audio.js:6](services/audio.js#L6), [imagenes.js:160](services/imagenes.js#L160) | Reutilizar un solo cliente; la librería cachea y renueva el token sola. |
| `execSync` de FFmpeg para el placeholder **bloquea el event loop** (y todos los SSE) | [imagenes.js:274](services/imagenes.js#L274) | Generar el PNG negro una vez al arrancar y copiarlo con `fs.promises.copyFile`. |
| La galería en memoria crece sin límite | [imagenes.js:16](services/imagenes.js#L16) | Limitarla a unas 200 entradas (FIFO). |
| No se limpia `output/` | global | Job de retención (por ejemplo, borrar trabajos de más de 30 días que ya se subieron o enviaron) con `OUTPUT_RETENCION_DIAS`. Los PNG de 2–3 MB se acumulan rápido. |
| Las imágenes de los shorts con OpenAI se generan en serie | [imagenes.js:319](services/imagenes.js#L319) | Generar la 1.ª (referencia automática) y las siguientes con concurrencia 2–3, reutilizando `ejecutarConLimite` y el espaciado de `escenasLargo`. Reduce el tiempo total en torno a un 50 %. |
| Pausa fija de 35 s entre imágenes de Google | [imagenes.js:346](services/imagenes.js#L346) | Usar el mismo limitador por tiempo que ya existe en `escenasLargo.generarImagenesEscenas`. |
| Guion en 2 llamadas a `gpt-4o` más storyboard en `gpt-4o` | guion.js, storyboard.js | Probar `gpt-4o-mini` para el borrador (la mejora mantiene la calidad) y medir costo y calidad. Configurable por nicho: `guion.modelo`. |
| `cargarNicho` lee 6 archivos del disco en cada request | nichos.js | Caché en memoria invalidada por `mtime` (bajo impacto, opcional). |
| El caption se envía dos veces a Telegram (mensaje + caption del video) | [telegram.js:23-34](services/telegram.js#L23-L34) | Enviar solo uno (el del video, recortado) salvo que supere 1024 caracteres. |

---

## 6. Calidad y operación

- **No hay tests.** Empezar por las funciones puras: `renderPrompt`, `agruparEscenas`, `trocearTexto`, `segmentarSeccion`, `validarRefImagePath`, `validarFechaProgramada`. Con `node --test` no hace falta ninguna dependencia nueva.
- **`/reenviar/:id` no tiene `limitarGenerar`**: se puede spamear el envío a Telegram.
- **`quality` no se valida** en `/generar` ni en `/util/imagenes-directas`. Aplicar una whitelist `low|medium|high`.
- **Logs**: pasar `console.*` a un logger con niveles y el id del trabajo en cada línea, ya que hay pipelines concurrentes cuyas salidas se mezclan.
- **CLAUDE.md**: la referencia "imagenes.js:718 en server.js" está desactualizada (ahora es [server.js:723](server.js#L723)).

---

## 7. Hoja de ruta propuesta

| Fase | Contenido | Riesgo de romper algo |
|---|---|---|
| **1 — Urgente (esta semana)** | §2.1 OAuth, §2.2 migración de `gpt-image-1`, §2.3 defaults del nicho, §2.4 carrera en curso, §2.6–2.9 | Bajo |
| **2 — Base técnica** | `services/openai.js`, `googleAuth.js` singleton, `utils/concurrencia.js`, `constantes.js`, timeouts, escritura atómica, placeholder async | Bajo (refactor interno) |
| **3 — Estructura** | `lib/sse.js` con replay, partir `server.js` en `routes/` y `pipelines/`, unificar eventos (con alias) | Medio: probar el frontend en cada página |
| **4 — Automatización** | Cola de pipelines, `ideas.js`, `tendencias.js` (RSS primero), `scheduler.js` en el mismo proceso, retención de `output/` | Bajo (todo son módulos nuevos) |
| **5 — Mejora continua** | Prompts de YouTube y largo movidos a archivos por nicho, imágenes en paralelo, tests, historial unificado, `API_KEY` usable desde el frontend | Medio |
