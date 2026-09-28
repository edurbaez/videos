# CLAUDE.md — Contexto del proyecto

## Qué es este proyecto

Servidor Express (Node.js) que genera YouTube Shorts de forma automática. El usuario elige un **nicho** y un **tema**; el sistema produce guion, audio, imágenes y video, y los envía a Telegram. Opcionalmente sube el video a YouTube.

El pipeline está completamente parametrizado por nicho: cada nicho tiene su propia configuración y prompts externos (archivos `.txt`), por lo que no hay texto de dominio hardcodeado en el JS.

---

## Arrancar el servidor

```bash
node server.js
# o con hot-reload:
npm run dev
# tests (node --test, sin APIs de pago: axios se mockea)
npm test
```

Puerto por defecto: 3000. Cambiar con `PORT=` en `.env`.

---

## Arquitectura del pipeline

```
POST /generar  { tema, nicho, editarGuion, ... }   → routes/shorts.js (validación + res.json({id}))
  └── pipelines/short.js ejecutar(params, emit)      (Promise; rechaza si falla)
  └── cargarNicho(id)                → services/nichos.js
  └── generarGuion(tema, id, nichoConfig)     → services/guion.js
  └── [PAUSA OPCIONAL si editarGuion=true]
       └── POST /continuar/:id       → reanuda con guion editado
  └── (en paralelo)
       ├── generarCaption(guion, nichoConfig) → services/caption.js
       ├── generarAudio(guion, id, voz, tts)  → services/audio.js
       └── generarImagenes(...)               → services/imagenes.js
              └── generarStoryboard(...)      → services/storyboard.js
  └── renderizarVideo(...)           → services/video.js
  └── enviarTelegram(...)            → services/telegram.js
  └── [OPCIONAL] subirYoutube(...)   → services/youtube.js
  └── guardarEntrada(...)            → utils/historial.js
```

El progreso se emite al cliente como **Server-Sent Events (SSE)** durante toda la ejecución.

**Capas:** `server.js` es solo bootstrap (CORS → rate limit → API key → json → static → routers → error handler). `routes/*.js` validan y responden; `pipelines/{short,curso,largo}.js` exportan `ejecutar(params, emit) → Promise<resultado>` (emiten `pipeline_error` y relanzan si fallan; reutilizables desde un scheduler). `lib/sse.js` `crearCanal(nombre, { aliasError })` guarda un buffer de eventos por id y lo reenvía al conectar (respeta `Last-Event-ID`); se borra 10 min después de `finalizado`/`pipeline_error`. Evento de error canónico: `pipeline_error`; alias temporales `error_pipeline` (shorts) y `error` (util) hasta migrar los HTML.

---

## Sistema de nichos

### Cómo funciona

`services/nichos.js` expone dos funciones:
- `listarNichos()` — lee las carpetas de `nichos/` y devuelve array `[{ id, nombre, descripcion, defaults }]`
- `cargarNicho(id)` — carga `config.json` + los 5 archivos de prompts `.txt` y devuelve un objeto `nichoConfig`

El objeto `nichoConfig` que viaja por todo el pipeline tiene esta forma:

```js
{
  id, nombre, descripcion, idioma,
  defaults: { voz, tts, estilo, escenario, cantidadImagenes, modeloImagen, apiImagen },
  guion:    { palabrasObjetivo, tono, estructura, modelo? },  // modelo: borrador (gpt-4o | gpt-4o-mini, default gpt-4o); la mejora siempre gpt-4o
  caption:  { estilo, ctaDefault, hashtagsBase },
  imagenes: { estiloNarrativo, arcoNarrativo, requiereStoryboard, tipoEscenas },
  automatizacion: { tendencias },   // scheduler: false en salud_*
  youtube:  { categoria, canal? },  // categoria: categoryId de YouTube (default 27); canal: subida del scheduler
  prompts:  { guionBorrador, guionMejora, caption, imagenes, storyboard,          // strings
              youtubeTitulo, youtubeDescripcion, youtubeTags,                    // prompt-youtube-*.txt
              imagenesBloque }                                                   // opcional (null si falta)
}
```

`cargarNicho` cachea en memoria (se invalida por mtime/tamaño de cualquier archivo del nicho) y devuelve una copia. Si faltan los `prompt-youtube-*.txt`, `generarMetadatosShorts` usa los prompts internos originales (español, tono motivacional). Si falta `prompt-imagenes-bloque.txt` se usa `prompts/shorts/imagenes-bloque.txt`.

Prompts compartidos (no por nicho): `prompts/curso/` (guion, humanización, `youtube-*.txt` de curso y largo), `prompts/largo/` (esquema, sección, formatos, director de arte), `prompts/shorts/`. Se leen con `utils/prompts.js:leerPromptArchivo(carpeta, archivo)`, que valida ambos nombres contra path traversal.

### Placeholders en prompts

`utils/prompts.js:renderPrompt(template, vars)` reemplaza `{{key}}` con los valores del objeto `vars`. Los servicios llaman a `renderPrompt` pasando los datos del nicho y del request antes de llamar a la API.

### Añadir un nuevo nicho

1. Crear `nichos/<id>/config.json` — copiar estructura de un nicho existente
2. Crear los prompts `.txt` en esa misma carpeta (5 base + 3 `prompt-youtube-*.txt`) y `youtube.categoria` en el config
3. Listo — `GET /nichos` lo detecta automáticamente

---

## Archivos clave

| Archivo | Responsabilidad |
|---|---|
| `server.js` | Bootstrap: middlewares, static, montaje de routers |
| `routes/*.js` | `shorts`, `util`, `curso`, `largo`, `youtube`: validación + respuesta |
| `pipelines/*.js` | `short`, `curso`, `largo`: lógica async `ejecutar(params, emit)` |
| `lib/sse.js` | Canal SSE reutilizable con replay |
| `lib/opcionesYoutube.js` | `resolverOpcionesYoutube(body, modo)`: canal/privacidad/fecha |
| `middleware/seguridad.js` | Rate limiting, validación, sanitización, magic bytes |
| `services/nichos.js` | Loader de nichos (caché por mtime, valida el id) |
| `services/guion.js` | Genera guion en 2 pasos (borrador con `guion.modelo` del nicho, mejora con GPT-4o) |
| `services/caption.js` | Genera caption con GPT-4o-mini |
| `services/imagenes.js` | Genera prompts visuales + llama a gpt-image-2 / gpt-image-1-mini / Google Imagen. `generarImagenes(opciones)` y `generarImagenesSecuencial(opciones)` reciben un objeto. Shorts: la 1.ª imagen (referencia automática OpenAI) en serie y el resto en paralelo (3 OpenAI / 2 Google) con limitador por tiempo `MS_ENTRE_IMAGENES` |
| `services/storyboard.js` | Genera storyboard estructurado por nicho |
| `services/audio.js` | Síntesis TTS (Google Neural2 o OpenAI) |
| `services/subtitulos.js` | Genera subtítulos SRT con Whisper (OpenAI) |
| `services/video.js` | Renderizado FFmpeg 1080×1920 con xfade |
| `services/telegram.js` | Envío de archivos y mensajes a Telegram (caption una sola vez: pie del video, o texto aparte si supera 1024) |
| `services/youtube.js` | Subida a YouTube (OAuth2 por canal, metadata GPT desde `nichos/<id>/prompt-youtube-*.txt` o `prompts/curso/youtube-*.txt`, `categoryId` del nicho) |
| `services/guionLargo.js` | Guion largo por secciones (esquema + sección a sección), monólogo o diálogo F/M |
| `services/audioLargo.js` | TTS troceado (≤4000 bytes/pieza), une secciones con FFmpeg, calcula capítulos y línea de tiempo por oración |
| `services/escenasLargo.js` | Agrupa la línea de tiempo en escenas (~N s), director de arte (guía de estilo + prompt/texto por escena, prompts en `prompts/largo/`), imágenes por escena y ASS con texto clave. Horizontal (largo) o vertical (`/curso/generar`, prompts de guion en `prompts/curso/`) |
| `services/openai.js` | `chat({ model, prompt|messages, json, maxTokens, temperature, timeout })`: única vía a Chat Completions (timeout 120 s, reintento con backoff ante 429/5xx) |
| `services/googleAuth.js` | Singleton de `GoogleAuth` + `obtenerAccessToken()` (TTS e Imagen) |
| `utils/prompts.js` | `renderPrompt()`, `joinHashtags()` y `leerPromptArchivo(carpeta, archivo)` (validado) |
| `utils/estilos.js` | Mapas de estilos/escenarios (ES → EN) para prompts |
| `utils/archivos.js` | Rutas y URLs de output (`urlAudio`, `urlImagen`, `urlVideo`, `urlCurso`, `urlDeRuta`), creación de carpetas y `escribirJsonAtomico()` (tmp + rename, reintento EBUSY/EPERM) para JSON de estado |
| `utils/constantes.js` | `LANG_NAMES`, idiomas y niveles de curso/largo, `MS_ENTRE_IMAGENES`; reexporta modelos de imagen de `seguridad.js` |
| `utils/concurrencia.js` | `ejecutarConLimite(tareas, limite)` y `crearLimitadorTiempo(ms)` (espaciado entre peticiones de imagen, compartido por workers y reintentos) |
| `utils/log.js` | `ts()` para timestamps de log |
| `utils/historial.js` | Historial unificado `historial.json` con `tipo: 'short' \| 'curso' \| 'largo'` (sin `tipo` = short; 50 por tipo; escritura atómica). `GET /historial` devuelve shorts por defecto (`?tipo=curso\|largo\|todos`); `/reenviar/:id` solo shorts |
| `public/js/api.js` | Incluido en todos los HTML: guarda la `API_KEY` en localStorage (la pide con `prompt` ante un 401), la envía en `x-api-key` en `fetch`, como `?apiKey=` en `EventSource` y como cookie `SameSite=Strict` para `/output/*` y `/youtube/auth` |
| `test/*.test.js` | Tests con `node --test` (sin dependencias): funciones puras, SSE, cola, ideas, tendencias, retención, historial, API key e imágenes/YouTube con axios mockeado |
| `lib/cola.js` | Cola global en memoria (`MAX_PIPELINES`): short, curso, largo y util de imágenes/audio esperan slot y emiten SSE `en_cola { posicion }`. El short libera el slot durante la pausa de `editarGuion` y lo vuelve a pedir al confirmar |
| `services/ideas.js` | Lee `ideas.csv` (solo lectura; `nicho,idea_base,prioridad[,canal]`, ver `ideas.example.csv`); estado de uso en `ideas-estado.json` (escritura atómica). Elige la no usada de mayor prioridad rotando nichos; resetea al agotarse |
| `services/tendencias.js` | Titular reciente de Google News RSS (timeout 10 s, saneado ≤120 chars). Desactivado con `automatizacion.tendencias: false` en el `config.json` del nicho (`salud_*`) |
| `services/retencion.js` | Borra trabajos de `output/` más antiguos que `OUTPUT_RETENCION_DIAS` (nunca archivos sueltos en `output/`, dotfiles, `_placeholder-*`, symlinks ni trabajos activos) |
| `scheduler.js` | `node-cron` en el mismo proceso: video diario (idea + tendencia como contexto opcional → `pipelines/short` vía cola; sube `unlisted` si hay canal en el CSV o `youtube.canal` del nicho). Marca la idea solo si termina bien, avisa a Telegram, recupera la ejecución perdida del día (`scheduler-estado.json`). También agenda la retención |

---

## Endpoints principales

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/nichos` | Lista nichos disponibles |
| `POST` | `/generar` | Pipeline completo (video) |
| `POST` | `/continuar/:id` | Confirma guion editado y reanuda pipeline pausado |
| `GET` | `/progreso/:id` | SSE de progreso del pipeline principal |
| `GET` | `/historial` | Últimas 50 generaciones |
| `POST` | `/reenviar/:id` | Reenvía un video a Telegram |
| `GET` | `/galeria` | Imágenes de la sesión actual |
| `POST` | `/util/guion` | Solo guion + caption → Telegram |
| `POST` | `/util/imagenes` | Solo imágenes → Telegram |
| `POST` | `/util/imagenes-directas` | Imágenes con prompt directo |
| `POST` | `/util/audio` | Solo audio → Telegram |
| `POST` | `/util/subir-referencia` | Sube imagen de referencia (multipart) |
| `GET` | `/youtube/canales` | Lista canales con estado OAuth |
| `GET` | `/youtube/auth` | Inicia flujo OAuth2 para un canal |
| `GET` | `/youtube/callback` | Callback OAuth2 de Google |
| `POST` | `/curso/generar` | Genera audio/video para curso de idiomas |
| `GET` | `/curso/archivos` | Lista archivos generados del curso |
| `POST` | `/largo/generar` | Video largo horizontal de idiomas (3–`LARGO_MAX_MINUTOS` min, 1 o 2 voces) |
| `GET` | `/largo/progreso/:id` | SSE del video largo |
| `GET` | `/largo/archivos` | Lista videos largos generados (`output/largo/*.json`) |
| `GET` | `/scheduler/estado` | Estado del scheduler, cola, ideas y retención |
| `POST` | `/scheduler/ejecutar` | Disparo manual del video automático (solo con `SCHEDULER_ENABLED=true`) |

---

## Revisión de seguridad post-implementación

Después de implementar cualquier característica o modificación, **revisar automáticamente el código introducido** en busca de vulnerabilidades comunes (OWASP Top 10, inyección de comandos, exposición de secretos, validación de entrada, etc.) y devolver un informe corto con el siguiente formato:

```
### Revisión de seguridad
- **Vulnerabilidades encontradas**: [lista o "ninguna"]
- **Riesgo**: [Alto / Medio / Bajo / Ninguno]
- **Soluciones propuestas**:
  1. ...
  2. ...
```

Si no se detectan vulnerabilidades, indicarlo brevemente. El informe debe ser conciso (máx. 10 líneas).

---

## Convenciones del proyecto

- **dotenv**: se carga solo en la línea 1 de `server.js`; un script que requiera servicios por separado debe llamar a `require('dotenv').config()` antes.
- **Compatibilidad hacia atrás**: si no llega `nicho` en el request, usar `'motivacion'` por defecto.
- **Defaults del nicho**: si el usuario no especifica voz/tts/estilo, se usan los defaults del `config.json` del nicho.
- **IDs únicos**: cada generación usa un UUID (`uuid`) para nombrar archivos; nunca se sobreescriben entre generaciones simultáneas.
- **Placeholders vacíos**: `renderPrompt` deja el placeholder vacío si la clave no existe (no lanza error).
- **Historial**: `guardarEntrada` guarda siempre `nicho`, `nombreNicho` y `parametros`; entradas antiguas sin `nicho` son compatibles.
- **Edición de guion**: si `editarGuion=true` en POST /generar, el pipeline se pausa tras `guion_listo` esperando `POST /continuar/:id` con el guion confirmado (timeout 10 min). El guion editado reemplaza al original en audio, imágenes, caption, YouTube y historial.

---

## Variables de entorno requeridas

```
OPENAI_API_KEY
GOOGLE_APPLICATION_CREDENTIALS
GOOGLE_PROJECT_ID
GOOGLE_LOCATION
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
FFMPEG_PATH
PORT              (opcional, default 3000)
API_KEY           (opcional — exige la clave: header x-api-key en cualquier ruta; ?apiKey= solo en rutas SSE; cookie apiKey solo en GET /output/* y /youtube/auth. El frontend estático y /youtube/callback no la exigen. El frontend la pide y guarda vía public/js/api.js)
CORS_ORIGIN       (opcional — default http://localhost:PORT)
LARGO_MAX_MINUTOS (opcional — duración máxima de videos largos, default 30)
LARGO_SEGUNDOS_POR_IMAGEN (opcional — default de segundos por imagen en videos largos, 10–120, default 30)
LARGO_SEGUNDOS_ENTRE_IMAGENES (opcional — separación mínima entre peticiones de imagen en videos largos para no pasar la cuota por minuto, 0–60, default 10)
MAX_PIPELINES     (opcional — pipelines simultáneos en la cola global, default 1)
SCHEDULER_ENABLED (opcional — "true" activa el video automático diario; desactivado por defecto)
SCHEDULER_CRON    (opcional — cron del video diario, default "0 9 * * *")
SCHEDULER_TZ      (opcional — zona horaria del scheduler y la retención, default America/Mexico_City)
OUTPUT_RETENCION_DIAS (opcional — borra trabajos de output/ con más de N días, a las 03:30 y al arrancar; 0 o sin definir = desactivado)
```

---

## Notas de modelos / APIs externas

**Modelos de imagen**: la lista de modelos permitidos y los defaults viven solo en `middleware/seguridad.js` (`MODELOS_OPENAI`, `MODELO_IMAGEN_*`). `gpt-image-1` (retirado el 23-oct-2026) ya no se usa: `normalizarModeloImagen` lo trata como alias de `gpt-image-2`.

**Revisión periódica de APIs**: revisar cada 30 días el estado/pricing/deprecations de OpenAI (GPT-4o, GPT-4o-mini, gpt-image-2, gpt-image-1-mini, Whisper) y Google Cloud (Text-to-Speech Neural2, Imagen 3, Vertex AI).
- Última revisión: 2026-09-14
- Próxima revisión: 2026-10-14

---

## Estado actual del sistema

Implementación completa. Ver `PROGRESO.md` para el detalle de cada fase y sesión.

**Nichos listos (9):** `motivacion`, `curiosidades`, `filosofia`, `misterio`, `ia_tecnologia`, `historia`, `guerra`, `salud_ejercicio`, `salud_alimentacion`.

**Funcionalidades activas:**
- Pipeline completo de video con SSE en tiempo real
- Edición de guion antes de continuar (toggle activable en el formulario)
- Subida automática a YouTube con OAuth2 por canal
- Subtítulos con Whisper + quemados en video con FFmpeg
- Imagen de referencia opcional (consistencia visual entre imágenes OpenAI)
- Seguridad completa (rate limiting, path traversal, magic bytes, sanitización)
- Servicio de videos de curso (audios/videos educativos multiidioma)
- Frontend multi-servicio: index con links a todos los servicios
