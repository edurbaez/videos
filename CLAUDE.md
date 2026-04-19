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
```

Puerto por defecto: 3000. Cambiar con `PORT=` en `.env`.

---

## Arquitectura del pipeline

```
POST /generar  { tema, nicho, editarGuion, ... }
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
  guion:    { palabrasObjetivo, tono, estructura },
  caption:  { estilo, ctaDefault, hashtagsBase },
  imagenes: { estiloNarrativo, requiereStoryboard, tipoEscenas },
  prompts:  { guionBorrador, guionMejora, caption, imagenes, storyboard }  // strings
}
```

### Placeholders en prompts

`utils/prompts.js:renderPrompt(template, vars)` reemplaza `{{key}}` con los valores del objeto `vars`. Los servicios llaman a `renderPrompt` pasando los datos del nicho y del request antes de llamar a la API.

### Añadir un nuevo nicho

1. Crear `nichos/<id>/config.json` — copiar estructura de un nicho existente
2. Crear los 5 prompts `.txt` en esa misma carpeta
3. Listo — `GET /nichos` lo detecta automáticamente

---

## Archivos clave

| Archivo | Responsabilidad |
|---|---|
| `server.js` | Rutas Express, pipeline principal, SSE |
| `middleware/seguridad.js` | Rate limiting, validación, sanitización, magic bytes |
| `services/nichos.js` | Loader de nichos |
| `services/guion.js` | Genera guion en 2 pasos con GPT-4o |
| `services/caption.js` | Genera caption con GPT-4o-mini |
| `services/imagenes.js` | Genera prompts visuales + llama a gpt-image-1 / Google Imagen |
| `services/storyboard.js` | Genera storyboard estructurado por nicho |
| `services/audio.js` | Síntesis TTS (Google Neural2 o OpenAI) |
| `services/subtitulos.js` | Genera subtítulos SRT con Whisper (OpenAI) |
| `services/video.js` | Renderizado FFmpeg 1080×1920 con xfade |
| `services/telegram.js` | Envío de archivos y mensajes a Telegram |
| `services/youtube.js` | Subida a YouTube (OAuth2 por canal, metadata GPT) |
| `utils/prompts.js` | `renderPrompt()` y `joinHashtags()` |
| `utils/estilos.js` | Mapas de estilos/escenarios (ES → EN) para prompts |
| `utils/archivos.js` | Rutas de output y creación de carpetas |
| `utils/historial.js` | CRUD del historial JSON (últimas 50 entradas) |

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
API_KEY           (opcional — activa autenticación por header x-api-key)
CORS_ORIGIN       (opcional — default http://localhost:PORT)
```

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
