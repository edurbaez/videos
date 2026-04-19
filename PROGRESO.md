# Plan de implementación: Generador de Shorts Multi-Nicho

## Estado general
✅ **COMPLETADO** — Sistema completamente implementado con todas las funcionalidades activas.

---

## Fases del sistema multi-nicho

### ✅ Fase 1 — Capa de nichos (archivos y loader)
- `nichos/motivacion/` y `nichos/curiosidades/` — config.json + 5 prompts .txt
- `services/nichos.js` — listarNichos(), cargarNicho(id)
- `utils/prompts.js` — renderPrompt(), joinHashtags()

### ✅ Fase 2 — server.js conectado al sistema de nichos
- Endpoint `GET /nichos`, extracción de `nicho` del body, fusión de defaults
- `nichoConfig` viaja por todo el pipeline

### ✅ Fase 3 — services/guion.js parametrizado por nicho
- Prompts leídos de `nichoConfig.prompts.guionBorrador/guionMejora`
- Sin texto motivacional hardcodeado

### ✅ Fase 4 — services/caption.js parametrizado por nicho
- Prompt leído de `nichoConfig.prompts.caption`, hashtags via joinHashtags()

### ✅ Fase 5 — services/imagenes.js + storyboard.js parametrizados
- `generarPromptVisual`, `generarTodosPrompts`, `generarImagenes`, `generarImagenesSecuencial` — todos con nichoConfig
- `storyboard.js` usa `nichoConfig.prompts.storyboard` con renderPrompt

### ✅ Fase 6 — Defaults de audio por nicho
- `vozFinal`, `ttsFinal` fusionados en server.js desde `nichoConfig.defaults`

### ✅ Fase 7 — Historial extendido
- `guardarEntrada` guarda `nicho`, `nombreNicho` y `parametros` completos
- Compatibilidad hacia atrás con entradas antiguas

### ✅ Fase 8 — Frontend: selector de nicho
- `<select id="v_inputNicho">` en formulario de video
- `vCargarNichos()` carga nichos dinámicamente desde `/nichos`
- `vAplicarDefaultsNicho()` aplica defaults de voz/tts al cambiar nicho

---

## Nichos disponibles

| ID | Nombre | Estado |
|----|--------|--------|
| `motivacion` | Motivación | ✅ Listo |
| `curiosidades` | Curiosidades | ✅ Listo |
| `filosofia` | Filosofía | ✅ Listo |
| `misterio` | Misterio | ✅ Listo |
| `ia_tecnologia` | IA y Tecnología | ✅ Listo |
| `historia` | Historia | ✅ Listo |
| `guerra` | Guerra | ✅ Listo |
| `salud_ejercicio` | Salud y Ejercicio | ✅ Listo |
| `salud_alimentacion` | Alimentación y Recetas | ✅ Listo |

---

## Funcionalidades adicionales implementadas

### ✅ Seguridad (2026-04-10)
Módulo `middleware/seguridad.js` con 11 controles:
- Path traversal (nicho, refImagePath)
- SSRF via modelo (whitelist)
- Rate limiting global (200/15min) y por generación (10/min)
- Autenticación opcional por API key (header `x-api-key`)
- Límite de `cantidad` (máx 20), límite de SSE simultáneos (50)
- Sanitización de `tema` (trim + slice 500)
- Magic bytes en uploads de imagen
- CORS configurable, errores genéricos en producción
- `npm audit fix` aplicado (axios, path-to-regexp)

### ✅ Subtítulos con Whisper
- `services/subtitulos.js` — genera SRT desde el audio con Whisper (OpenAI)
- FFmpeg quema los subtítulos en el video final
- Activable con `subtitulos: true` en el POST /generar
- Fallo suave: si Whisper falla, el video continúa sin subtítulos

### ✅ YouTube upload
- `services/youtube.js` — OAuth2 por canal (múltiples canales en `youtube-channels.json`)
- Metadata generados por GPT (título, descripción, tags)
- Endpoints: `/youtube/canales`, `/youtube/auth`, `/youtube/callback`
- Toggle en formulario de video con selector de canal y privacidad
- Pasos SSE: `youtube_subiendo`, `youtube_metadatos`, `youtube_listo`, `youtube_error`

### ✅ Imagen de referencia
- Upload via `POST /util/subir-referencia` (multipart, verificación magic bytes)
- Ruta validada contra path traversal antes de usar
- Compatible con pipeline de video e imágenes directas
- Solo funciona con modelos OpenAI (ignorada con Google Imagen)

### ✅ Modelos de imagen actualizados
- DALL-E 2 y DALL-E 3 deprecados (sunset: 12 mayo 2026)
- Sistema migrado a `gpt-image-1` y `gpt-image-1-mini`
- Soporte de calidad configurable: `low`, `medium`, `high`
- Google Imagen 3 y 4 preview disponibles como alternativa

### ✅ Servicio de curso de idiomas
- `POST /curso/generar` — audio MP3 + video con TTS en alemán, inglés, español, francés, portugués
- `GET /curso/archivos` — lista archivos generados
- Frontend: `public/videos_curso.html`, `public/audios-de-aleman.html`

### ✅ Edición de guion antes de continuar (2026-04-19)
- Flag `editarGuion` (boolean) en `POST /generar`
- Tras `guion_listo`, el pipeline se pausa (Promise en espera, timeout 10 min)
- `POST /continuar/:id` — recibe guion editado, reanuda el pipeline
- El guion editado reemplaza al original en todo lo posterior (audio, imágenes, caption, YouTube, historial)
- Toggle visual en el formulario (`creacion_de_contenido.html`)
- Evento SSE `guion_confirmado` notifica que el pipeline reanudó

### ✅ Frontend multi-servicio (2026-04-19)
- `index.html` — página principal con grid de links a todos los servicios
- `creacion_de_contenido.html` — Generador de Video puro (Audio e Imágenes tienen páginas propias)
- `guion.html`, `audio.html`, `imagenes.html` — servicios independientes
- `videos_curso.html`, `audios-de-aleman.html` — servicios de curso

---

## Sesiones de trabajo

| Sesión | Fecha | Completado |
|--------|-------|-----------|
| 1 | 2026-04-04 | Fase 1 + Fase 7 |
| 2 | 2026-04-04 | Fase 2 |
| 3 | 2026-04-04 | Fase 3 |
| 4 | 2026-04-04 | Fase 4 |
| 5 | 2026-04-04 | Fase 5 + endpoints util |
| 6 | 2026-04-04 | Fase 8 (frontend selector de nicho) |
| 7 | 2026-04-10 | Seguridad, YouTube, subtítulos, imagen de referencia, modelos imagen, curso de idiomas |
| 8 | 2026-04-19 | Edición de guion antes de continuar, refactorización frontend |
