# Generador de Shorts Motivacionales

Genera YouTube Shorts motivacionales de forma automática:
**Guion → Audio → Imágenes → Video → Telegram**

Incluye además utilidades independientes para generar solo guiones, imágenes o audios.

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

Crear un archivo `.env` en la raíz del proyecto con el siguiente contenido:

```env
# OpenAI — guion, caption y prompts visuales (GPT-4o / GPT-4o-mini)
#         — imágenes opcionales (DALL-E 3 / DALL-E 2)
OPENAI_API_KEY=sk-...

# Google Cloud — TTS y generación de imágenes con Imagen 3 (Vertex AI)
GOOGLE_APPLICATION_CREDENTIALS=C:\ruta\a\tu\service-account.json
GOOGLE_PROJECT_ID=mi-proyecto-123
GOOGLE_LOCATION=us-central1

# Telegram — envío automático de videos, audios e imágenes
TELEGRAM_BOT_TOKEN=123456789:AAF...
TELEGRAM_CHAT_ID=123456789

# FFmpeg
FFMPEG_PATH=C:\ffmpeg\ffmpeg\bin\ffmpeg.exe

# Servidor (opcional, default: 3000)
PORT=3000
```

---

## Cómo obtener cada credencial

### OpenAI (`OPENAI_API_KEY`)

1. Ir a [platform.openai.com](https://platform.openai.com)
2. Menu → **API Keys** → **Create new secret key**
3. Copiar la clave generada (empieza con `sk-`)

> Se usa para: guion (GPT-4o), caption y prompts visuales (GPT-4o-mini), imágenes (DALL-E 3 o DALL-E 2).

---

### Google Cloud — Service Account (`GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_PROJECT_ID`, `GOOGLE_LOCATION`)

Se necesita un **Service Account** con acceso a dos APIs: **Cloud Text-to-Speech** y **Vertex AI**.

**Paso 1 — Crear o seleccionar un proyecto**

1. Ir a [console.cloud.google.com](https://console.cloud.google.com)
2. Crear un proyecto nuevo o seleccionar uno existente
3. Anotar el **Project ID** (ej: `mi-proyecto-123`) → va en `GOOGLE_PROJECT_ID`

**Paso 2 — Habilitar las APIs necesarias**

En el proyecto, ir a **APIs y servicios → Biblioteca** y habilitar:

- **Cloud Text-to-Speech API**
- **Vertex AI API**

**Paso 3 — Crear el Service Account**

1. Ir a **IAM y administración → Cuentas de servicio**
2. Clic en **Crear cuenta de servicio**
3. Darle un nombre (ej: `generador-shorts`)
4. En **Roles**, asignar:
   - `Cloud Text-to-Speech User` (o `Editor` si no aparece el rol específico)
   - `Vertex AI User`
5. Clic en **Listo**

**Paso 4 — Descargar la clave JSON**

1. En la lista de cuentas de servicio, clic en la que acabas de crear
2. Pestaña **Claves** → **Agregar clave** → **Crear clave nueva** → tipo **JSON**
3. Se descarga un archivo `.json`
4. Guardar ese archivo en una ruta segura (ej: `C:\credentials\service-account.json`)
5. Poner esa ruta en `GOOGLE_APPLICATION_CREDENTIALS`

**`GOOGLE_LOCATION`**

La región de Vertex AI. Usar `us-central1` (recomendado, es la que tiene mejor disponibilidad de Imagen 3).

> Se usa para: síntesis de voz (Google TTS Neural2) e imágenes (Google Imagen 3 via Vertex AI).

---

### Telegram (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`)

**Token del bot (`TELEGRAM_BOT_TOKEN`)**

1. Abrir Telegram y buscar [@BotFather](https://t.me/BotFather)
2. Enviar `/newbot`
3. Seguir las instrucciones: elegir nombre y username para el bot
4. BotFather devuelve el token (ej: `123456789:AAFxxx...`)

**Chat ID (`TELEGRAM_CHAT_ID`)**

Opción A — Para enviar a tu chat personal:
1. Buscar [@userinfobot](https://t.me/userinfobot) en Telegram
2. Enviarle cualquier mensaje
3. Responde con tu ID numérico → ese es tu `TELEGRAM_CHAT_ID`

Opción B — Para enviar a un canal o grupo:
1. Agregar el bot al canal/grupo como administrador
2. Enviar un mensaje al canal/grupo
3. Visitar `https://api.telegram.org/bot<TOKEN>/getUpdates` en el navegador
4. Buscar el campo `"chat": { "id": -100xxxxxxxxx }` — ese número (con el signo `-`) es el `TELEGRAM_CHAT_ID`

> Se usa para: envío automático de videos, guiones, audios e imágenes al finalizar cada generación.

---

### FFmpeg (`FFMPEG_PATH`)

1. Descargar FFmpeg desde [ffmpeg.org/download.html](https://ffmpeg.org/download.html) (builds para Windows: gyan.dev o BtbN)
2. Extraer el zip en una carpeta (ej: `C:\ffmpeg\`)
3. El ejecutable estará en una ruta similar a `C:\ffmpeg\ffmpeg-7.x-full_build\bin\ffmpeg.exe`
4. Poner esa ruta exacta en `FFMPEG_PATH`

> FFmpeg también debe tener `ffprobe.exe` en la misma carpeta — se detecta automáticamente.

---

## Iniciar el servidor

```bash
node server.js
```

O con recarga automática al guardar cambios (requiere Node.js 18+):

```bash
npm run dev
```

Abrir el navegador en: [http://localhost:3000](http://localhost:3000)

---

## Funcionalidades

### 1. Pipeline completo — Video Short

Genera un Short completo end-to-end a partir de un tema.

**Flujo:**

```
Tema
 └─ Guion (GPT-4o, 2 pasos: borrador + mejora viral)
     ├─ Caption (GPT-4o-mini)             ─┐
     ├─ Audio (Google TTS Neural2)         ├─ en paralelo
     └─ Imágenes (DALL-E 3 / Imagen 3)   ─┘
         └─ Video (FFmpeg, 1080x1920, xfade)
             └─ Telegram (caption + video)
```

**Opciones disponibles en el formulario:**

| Opción | Valores | Default |
|---|---|---|
| Cantidad de imágenes | 1 – 6 | 1 |
| Voz del audio | `masculino` / `femenino` | `femenino` |
| API de imágenes | `openai` / `google` | `openai` |
| Modelo de imágenes | ver tabla abajo | `dall-e-3` |

**Modelos de imágenes disponibles:**

| API | Modelo | Resolución |
|---|---|---|
| `openai` | `dall-e-3` | 1024×1792 (9:16) |
| `openai` | `dall-e-2` | 1024×1024 (cuadrado) |
| `google` | `imagen-3.0-generate-002` | 9:16 nativo |

**Voces de audio:**

| Opción | Voz Google TTS |
|---|---|
| `masculino` | es-US-Neural2-B |
| `femenino` | es-US-Neural2-A |

**Progreso en tiempo real:** el frontend recibe eventos SSE paso a paso (guion listo, caption listo, audio listo, cada imagen lista, video listo, Telegram enviado).

---

### 2. Utilidad — Solo guion + caption → Telegram

Genera el guion (2 pasos con GPT-4o) y el caption, y los envía como texto a Telegram. No genera audio, imágenes ni video.

**Endpoint:** `POST /util/guion`
```json
{ "tema": "La disciplina supera al talento" }
```

---

### 3. Utilidad — Solo imágenes → Telegram

Genera un guion base y a partir de él crea N imágenes con DALL-E 3, enviando cada imagen a Telegram en cuanto está lista.

Los prompts se generan todos de una vez (en bloque) y luego las imágenes se producen secuencialmente.

**Endpoint:** `POST /util/imagenes`
```json
{ "tema": "El poder del enfoque", "cantidad": 4 }
```

---

### 4. Utilidad — Imágenes con prompt directo → Telegram

Genera N imágenes usando un prompt visual escrito directamente (sin pasar por GPT). Soporta Google Imagen 3 o DALL-E.

**Endpoint:** `POST /util/imagenes-directas`
```json
{
  "prompt": "Create an image of a lone runner at dawn crossing a finish line",
  "cantidad": 3,
  "api": "google",
  "modelo": "imagen-3.0-generate-002"
}
```

---

### 5. Utilidad — Solo audio → Telegram

Genera el guion, lo convierte a MP3 con Google TTS y envía el guion (texto) + el audio (archivo) a Telegram.

**Endpoint:** `POST /util/audio`
```json
{ "tema": "Superar el miedo al fracaso", "genero": "masculino" }
```

---

### 6. Historial

Devuelve las últimas 50 generaciones completas (guion, caption, rutas de archivos, fecha).

**Endpoint:** `GET /historial`

Los videos del historial pueden reenviarse a Telegram con:

**Endpoint:** `POST /reenviar/:id`

---

### 7. Galería de imágenes

Devuelve todas las imágenes generadas durante la sesión actual del servidor (en memoria).

**Endpoint:** `GET /galeria`

---

## Estructura del proyecto

```
proyecto/
├── server.js              Servidor Express + rutas + SSE
├── .env                   Variables de entorno (no subir a git)
├── .gitignore
├── package.json
├── README.md
├── historial.json         Se crea automáticamente
├── services/
│   ├── guion.js           Genera el guion con GPT-4o (2 pasos)
│   ├── caption.js         Genera el caption con GPT-4o-mini
│   ├── audio.js           Sintetiza audio MP3 con Google TTS Neural2
│   ├── imagenes.js        Genera imágenes con DALL-E o Google Imagen 3
│   ├── video.js           Renderiza el video vertical con FFmpeg
│   └── telegram.js        Envía video, audio, fotos y texto a Telegram
├── utils/
│   ├── archivos.js        Rutas y creación de carpetas de output
│   └── historial.js       Lectura/escritura del historial JSON
├── public/
│   └── index.html         Frontend completo (HTML + CSS + JS)
└── output/                Se crea automáticamente
    ├── guiones/
    ├── audios/
    ├── imagenes/
    └── videos/
```

---

## Notas técnicas

- Cada generación usa un UUID único; los archivos nunca se sobreescriben entre generaciones simultáneas.
- Las imágenes del pipeline principal se generan **en paralelo**; las de la utilidad `/util/imagenes` se generan de forma **secuencial** (una a la vez, enviando cada una a Telegram inmediatamente).
- Si una imagen falla 2 veces seguidas, se sustituye por un **placeholder negro** (1080×1920) para no interrumpir el video.
- El video final es **H.264 + AAC 192k**, resolución **1080×1920** (9:16), con transiciones `xfade:fade` de 0.5 s entre imágenes. Si la duración del audio supera el tiempo de las imágenes, estas se repiten en bucle.
- El historial guarda las últimas **50 generaciones** en `historial.json`.
- El progreso de cada operación se transmite al frontend mediante **Server-Sent Events (SSE)**.
