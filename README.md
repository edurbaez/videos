# Generador de Shorts Multi-Nicho

Genera YouTube Shorts de forma automática para múltiples nichos de contenido:
**Nicho → Guion → Audio → Imágenes → Video → Telegram → YouTube**

Incluye utilidades independientes para generar solo guiones, imágenes o audios, y un sistema de nichos configurable con prompts externos.

---

## Requisitos previos

- Node.js 18 o superior
- FFmpeg instalado localmente (ver abajo)
- Cuentas activas en los servicios listados abajo

---

## Instalación

```bash
npm install
```

Luego completar el archivo `.env` con todas las claves (ver sección siguiente).

---

## Variables de entorno (.env)

```env
# OpenAI — guion, caption, prompts visuales, imágenes, subtítulos (Whisper)
OPENAI_API_KEY=sk-...

# Google Cloud — TTS Neural2 y Google Imagen (Vertex AI)
GOOGLE_APPLICATION_CREDENTIALS=C:\ruta\a\tu\service-account.json
GOOGLE_PROJECT_ID=mi-proyecto-123
GOOGLE_LOCATION=us-central1

# Telegram
TELEGRAM_BOT_TOKEN=123456789:AAF...
TELEGRAM_CHAT_ID=123456789

# FFmpeg
FFMPEG_PATH=C:\ffmpeg\ffmpeg\bin\ffmpeg.exe

# Servidor (opcional)
PORT=3000

# Seguridad (opcionales)
API_KEY=mi-clave-secreta        # activa autenticación por header x-api-key
CORS_ORIGIN=http://localhost:3000
```

---

## Cómo obtener cada credencial

### OpenAI (`OPENAI_API_KEY`)

1. Ir a [platform.openai.com](https://platform.openai.com)
2. Menu → **API Keys** → **Create new secret key**
3. Copiar la clave (empieza con `sk-`)

> Se usa para: guion (GPT-4o), caption y prompts visuales (GPT-4o-mini), imágenes (gpt-image-1), subtítulos (Whisper).

---

### Google Cloud (`GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_PROJECT_ID`, `GOOGLE_LOCATION`)

1. Ir a [console.cloud.google.com](https://console.cloud.google.com) y crear/seleccionar un proyecto
2. Habilitar **Cloud Text-to-Speech API** y **Vertex AI API**
3. Crear un Service Account con roles `Cloud Text-to-Speech User` y `Vertex AI User`
4. Descargar la clave JSON y poner su ruta en `GOOGLE_APPLICATION_CREDENTIALS`
5. `GOOGLE_LOCATION`: usar `us-central1`

---

### Telegram (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`)

- **Token:** [@BotFather](https://t.me/BotFather) → `/newbot` → copiar el token
- **Chat ID personal:** [@userinfobot](https://t.me/userinfobot) → enviar cualquier mensaje → copiar el ID
- **Chat ID de canal/grupo:** Agregar el bot como admin → `https://api.telegram.org/bot<TOKEN>/getUpdates` → buscar `"chat": { "id": -100... }`

---

### FFmpeg (`FFMPEG_PATH`)

1. Descargar desde [ffmpeg.org/download.html](https://ffmpeg.org/download.html)
2. Extraer en `C:\ffmpeg\`
3. Poner la ruta exacta del ejecutable en `FFMPEG_PATH`

> `ffprobe.exe` debe estar en la misma carpeta.

---

## Iniciar el servidor

```bash
node server.js
# o con recarga automática:
npm run dev
```

Abrir: [http://localhost:3000](http://localhost:3000)

---

## Sistema de nichos

### Nichos disponibles (9)

| ID | Nombre | Voz default | TTS |
|---|---|---|---|
| `motivacion` | Motivación | femenino | google |
| `curiosidades` | Curiosidades | masculino | google |
| `filosofia` | Filosofía | masculino | google |
| `misterio` | Misterio | masculino | google |
| `ia_tecnologia` | IA y Tecnología | masculino | openai |
| `historia` | Historia | masculino | google |
| `guerra` | Guerra | masculino | google |
| `salud_ejercicio` | Salud y Ejercicio | femenino | google |
| `salud_alimentacion` | Alimentación y Recetas | femenino | google |

### Estructura de un nicho

```
nichos/<id>/
├── config.json               Metadatos, defaults y parámetros
├── prompt-guion-borrador.txt Primer borrador del guion
├── prompt-guion-mejora.txt   Refinamiento del guion
├── prompt-caption.txt        Caption de YouTube/Telegram
├── prompt-imagenes.txt       Prompts visuales individuales
└── prompt-storyboard.txt     Storyboard completo
```

Los prompts usan placeholders `{{tema}}`, `{{tono}}`, `{{idioma}}`, etc.

### Añadir un nuevo nicho

1. Crear `nichos/<id>/` con `config.json` y los 5 prompts `.txt`
2. `GET /nichos` lo detecta automáticamente

---

## Modelos de imagen disponibles

### OpenAI

| Modelo | Calidad | Precio/imagen (portrait 1024×1536) |
|---|---|---|
| `gpt-image-1` | low / medium / high | $0.016 / $0.063 / $0.250 |
| `gpt-image-1-mini` | low / medium / high | $0.005 / $0.020 / $0.060 |

**Default:** `gpt-image-1` medium → ~$0.19/video (3 imgs). **Económico:** `gpt-image-1-mini` medium → ~$0.06/video.

> DALL-E 2 y DALL-E 3 deprecados por OpenAI (sunset: 12 mayo 2026).

### Google (Vertex AI)

| Modelo | Notas |
|---|---|
| `imagen-3.0-generate-002` | Imagen 3, 9:16 nativo |
| `imagen-4.0-generate-preview-05-20` | Imagen 4 preview |

---

## Funcionalidades

### 1. Pipeline completo — Generador de Video Short

**Flujo:**

```
Nicho + Tema
 └─ Guion (GPT-4o, 2 pasos con prompts del nicho)
     │   [PAUSA OPCIONAL: editar guion en el navegador]
     ├─ Caption (GPT-4o-mini)           ─┐
     ├─ Audio (Google TTS / OpenAI TTS)  ├─ en paralelo
     └─ Imágenes (gpt-image-1 / Imagen) ─┘
         └─ Storyboard narrativo
             └─ Video (FFmpeg 1080×1920 xfade)
                 └─ Telegram
                     └─ YouTube (opcional)
```

**Opciones del formulario:**

| Opción | Valores | Default |
|---|---|---|
| Nicho | 9 nichos | `motivacion` |
| Cantidad de imágenes | 1 – 8 | 1 |
| Voz | masculino / femenino | según nicho |
| Proveedor TTS | google / openai | según nicho |
| Modelo de imágenes | gpt-image-1, gpt-image-1-mini, Imagen 3, Imagen 4 | `gpt-image-1` |
| Estilo visual | cinemático, caricatura, b&n, acuarela, minimalista, cyberpunk | `cinematico` |
| Escenario | ciudad, bosque, lago, montaña, interior, abstracto | sin preferencia |
| Imagen de referencia | PNG/JPG/WebP opcional (solo OpenAI) | ninguna |
| Subir a YouTube | canal + privacidad configurables | desactivado |
| Editar guion | pausa el pipeline para editar el guion antes de continuar | desactivado |

**Endpoint:** `POST /generar`
```json
{
  "tema": "La disciplina supera al talento",
  "nicho": "motivacion",
  "cantidad": 3,
  "genero": "femenino",
  "tts": "google",
  "modelo": "gpt-image-1",
  "api": "openai",
  "estilo": "cinematico",
  "escenario": "ninguno",
  "editarGuion": false,
  "subirYoutube": false,
  "canalYoutube": "",
  "privacidadYoutube": "private"
}
```

---

### 2. Edición de guion antes de continuar

El pipeline se pausa tras generar el guion y muestra un textarea editable. Al confirmar, el guion editado se usa en todo lo posterior (audio, imágenes, caption, YouTube, historial).

**Flujo:**
1. Enviar `editarGuion: true` en el `POST /generar`
2. El servidor emite `guion_listo` y queda en espera
3. El usuario edita y hace clic en "Continuar"
4. El frontend llama `POST /continuar/:id` con el guion editado
5. El servidor emite `guion_confirmado` y reanuda

**Endpoint:** `POST /continuar/:id`
```json
{ "guion": "Texto del guion editado..." }
```

Timeout: 10 minutos. Guion máximo: 5000 caracteres.

---

### 3. Subida automática a YouTube

**Configuración:**
1. Crear `youtube-channels.json`:
```json
[{ "nombre": "mi-canal", "label": "Mi Canal", "descripcion": "..." }]
```
2. Autorizar: `http://localhost:3000/youtube/auth?canal=mi-canal`
3. Activar el toggle "Subir a YouTube" en el formulario y elegir privacidad

Los metadatos (título, descripción, tags) se generan con GPT a partir del guion.

**Endpoints:** `GET /youtube/canales` · `GET /youtube/auth` · `GET /youtube/callback`

---

### 4. Imagen de referencia

Los modelos OpenAI aceptan una imagen de referencia para mantener consistencia visual entre todas las imágenes del video.

1. Subir desde el formulario (PNG/JPG/WebP, máx. 50 MB)
2. El backend verifica magic bytes y usa `/v1/images/edits`

No compatible con Google Imagen.

**Endpoint:** `POST /util/subir-referencia` (multipart, campo `imagen`)

---

### 5. Subtítulos con Whisper

Genera SRT desde el audio y lo quema en el video final con FFmpeg.

Activar con `subtitulos: true` en el `POST /generar`. Fallo suave: si Whisper falla, el video continúa sin subtítulos.

---

### 6. Utilidades independientes

| Endpoint | Descripción |
|---|---|
| `POST /util/guion` | Guion + caption → Telegram |
| `POST /util/imagenes` | Imágenes desde guion → Telegram |
| `POST /util/imagenes-directas` | Imágenes desde prompt directo → Telegram |
| `POST /util/audio` | Guion + audio → Telegram |

---

### 7. Servicio de curso de idiomas

Genera audio TTS y video para material educativo multiidioma.

**Endpoint:** `POST /curso/generar`
```json
{ "texto": "Der Apfel ist rot.", "idioma": "de", "genero": "femenino" }
```

Idiomas: `de` (alemán), `en` (inglés), `es` (español), `fr` (francés), `pt` (portugués).

---

### 8. Historial y galería

| Endpoint | Descripción |
|---|---|
| `GET /nichos` | Nichos disponibles |
| `GET /historial` | Últimas 50 generaciones |
| `POST /reenviar/:id` | Reenvía un video a Telegram |
| `GET /galeria` | Imágenes de la sesión actual |

---

## Seguridad

El módulo `middleware/seguridad.js` aplica los siguientes controles:

| Control | Descripción |
|---|---|
| Path traversal | `nicho` y `refImagePath` validados con `path.resolve` |
| SSRF | `modelo` validado contra whitelist por API |
| Rate limiting | 200 req/15min global · 10 req/min en generación |
| Autenticación | API key opcional via header `x-api-key` |
| Sanitización | `tema`/`prompt`: trim + slice(0, 500) |
| Upload | Magic bytes verificados (PNG, JPEG, WebP) |
| SSE | Máx. 50 conexiones simultáneas |
| CORS | Configurable via `CORS_ORIGIN` |
| Producción | Errores genéricos si `NODE_ENV=production` |

---

## Estructura del proyecto

```
proyecto/
├── server.js
├── .env
├── youtube-channels.json           Canales de YouTube (no subir a git)
├── historial.json                  Se crea automáticamente
├── middleware/
│   └── seguridad.js
├── nichos/
│   ├── motivacion/                 config.json + 5 prompts .txt
│   ├── curiosidades/ · filosofia/ · misterio/ · ia_tecnologia/
│   ├── historia/ · guerra/ · salud_ejercicio/ · salud_alimentacion/
├── services/
│   ├── nichos.js · guion.js · caption.js · audio.js
│   ├── imagenes.js · storyboard.js · subtitulos.js
│   ├── video.js · telegram.js · youtube.js
├── utils/
│   ├── prompts.js · estilos.js · archivos.js · historial.js
├── public/
│   ├── index.html                  Página principal
│   ├── creacion_de_contenido.html  Generador de Video
│   ├── guion.html · audio.html · imagenes.html
│   ├── audios-de-aleman.html · videos_curso.html
└── output/
    ├── audios/ · imagenes/ · videos/ · subtitulos/
    ├── referencias/ · curso/
```

---

## Notas técnicas

- Cada generación usa un UUID único; los archivos nunca se sobreescriben.
- Las imágenes del pipeline principal se generan **en paralelo**; las de `/util/imagenes` son **secuenciales** (Telegram inmediato por imagen).
- Si una imagen falla 2 veces, se usa un **placeholder negro** 1080×1920 para no interrumpir el video.
- Video final: **H.264 + AAC 192k**, **1080×1920** (9:16), transiciones `xfade:fade` 0.5 s. Si el audio supera el tiempo de las imágenes, estas se repiten en bucle.
- Historial: últimas **50 generaciones** en `historial.json`.
- Progreso via **SSE** con heartbeat cada 20 s para mantener la conexión.
- Con `editarGuion=true`, el pipeline espera `POST /continuar/:id` (timeout 10 min).
