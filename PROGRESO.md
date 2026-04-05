# Plan de refactorización: Multi-nicho

## Estado general
✅ **COMPLETADO** — Sistema multi-nicho completamente implementado.
Todas las fases terminadas. La app soporta múltiples nichos end-to-end.

---

## Orden de implementación

```
Fase 1 → Fase 7 → Fase 2 → Fase 3 → Fase 4 → Fase 5 → Fase 8 → Fase 6
```

---

## Fases

### ✅ Fase 1 — Capa de nichos (archivos y loader)
**Objetivo:** Crear la infraestructura de nichos sin tocar código existente.

**Completado:**
- [x] `nichos/motivacion/config.json`
- [x] `nichos/motivacion/prompt-guion-borrador.txt`
- [x] `nichos/motivacion/prompt-guion-mejora.txt`
- [x] `nichos/motivacion/prompt-caption.txt`
- [x] `nichos/motivacion/prompt-imagenes.txt`
- [x] `nichos/motivacion/prompt-storyboard.txt`
- [x] `nichos/curiosidades/config.json`
- [x] `nichos/curiosidades/prompt-guion-borrador.txt`
- [x] `nichos/curiosidades/prompt-guion-mejora.txt`
- [x] `nichos/curiosidades/prompt-caption.txt`
- [x] `nichos/curiosidades/prompt-imagenes.txt`
- [x] `nichos/curiosidades/prompt-storyboard.txt`
- [x] `services/nichos.js` — loader central (listarNichos, cargarNicho)
- [x] `utils/prompts.js` — renderPrompt con {{placeholders}}

**Resultado:** Sin cambios al pipeline existente. Todo sigue funcionando igual.

---

### ✅ Fase 7 — Historial extendido
**Objetivo:** Guardar nicho y parámetros en cada entrada del historial.

**Completado:**
- [x] `utils/historial.js` — `guardarEntrada` acepta campo `nicho` y `parametros`
- [x] Compatibilidad hacia atrás: entradas antiguas sin `nicho` no rompen nada

**Notas:** El campo `nicho` es opcional; si no llega, se guarda como `'motivacion'` por defecto.

---

### ✅ Fase 2 — Adaptar server.js (recibir nicho + cargar config)
**Objetivo:** El pipeline conoce el nicho antes de empezar a generar.

**Completado:**
- [x] Import de `listarNichos` y `cargarNicho` desde `services/nichos.js`
- [x] Endpoint `GET /nichos` devuelve array de nichos disponibles
- [x] `POST /generar` extrae `nicho` del body (default `'motivacion'`)
- [x] `cargarNicho(nicho)` al inicio del pipeline — error 400 si nicho inválido
- [x] Fusión de defaults: `vozFinal`, `modeloFinal`, `apiFinal`, `ttsFinal`, `estiloFinal`, `escenarioFinal`
- [x] `nichoConfig` pasado como argumento extra a `generarGuion`, `generarCaption`, `generarImagenes`
  - JS ignora parámetros extra silenciosamente → pipeline sigue funcionando hasta Fases 3-5
- [x] `guardarEntrada` ahora incluye `nicho`, `nombreNicho` y `parametros` completos

**Archivos modificados:** `server.js`

**Notas:**
- El frontend aún no manda `nicho` → usa `'motivacion'` por defecto → sin regresión
- `generarGuion/Caption/Imagenes` reciben `nichoConfig` pero lo ignoran hasta Fases 3-5

---

### ✅ Fase 3 — Refactorizar services/guion.js
**Objetivo:** Prompts fuera del JS, parametrizados por nicho.

**Completado:**
- [x] Nueva firma: `generarGuion(tema, id, nichoConfig)`
- [x] Usar `nichoConfig.prompts.guionBorrador` y `nichoConfig.prompts.guionMejora`
- [x] Renderizar con `renderPrompt(template, { tema, tono, idioma, estructura, palabras_objetivo, nombre_nicho, borrador })`
- [x] Prompts consolidados en un solo `messages` (user), sin system separado
- [x] Guardado en disco igual

**Archivos modificados:** `services/guion.js`

**Riesgo:** ALTO — mayor acoplamiento actual. Probar en local antes de confirmar.

---

### ✅ Fase 4 — Refactorizar services/caption.js
**Objetivo:** Caption parametrizado por nicho.

**Completado:**
- [x] Nueva firma: `generarCaption(guion, nichoConfig)`
- [x] Usar `nichoConfig.prompts.caption`
- [x] Renderizar con `renderPrompt(template, { guion, nombre_nicho, caption_estilo, hashtags_base, cta })`
- [x] `joinHashtags()` convierte el array de hashtags del config a string

**Archivos modificados:** `services/caption.js`

**Riesgo:** BAJO

---

### ✅ Fase 5 — Refactorizar services/imagenes.js + storyboard.js
**Objetivo:** Quitar lenguaje motivacional hardcodeado de los prompts visuales.

**Completado:**
- [x] `generarPromptVisual(guion, n, total, estilo, escenario, nichoConfig)` — usa `nichoConfig.prompts.imagenes` con renderPrompt
- [x] `generarTodosPrompts(guion, cantidad, estilo, escenario, nichoConfig)` — usa `nichoConfig.imagenes.arcoNarrativo` y `nichoConfig.nombre`
- [x] `generarImagenes(..., nichoConfig)` — pasa nichoConfig a storyboard y generarPromptVisual
- [x] `generarImagenesSecuencial(..., nichoConfig)` — ídem
- [x] `storyboard.js` — usa `nichoConfig.prompts.storyboard` con renderPrompt; arco y nombre_nicho del config
- [x] Endpoints util `/util/guion`, `/util/imagenes`, `/util/audio` arreglados — cargan `motivacion` por defecto

**Archivos modificados:** `services/imagenes.js`, `services/storyboard.js`, `server.js`

**Riesgo:** ALTO — prompts visuales son delicados. Probar nicho por nicho.

---

### ✅ Fase 8 — Frontend (creacion_de_contenido.html)
**Objetivo:** Selector de nicho en el formulario de vídeo.

**Completado:**
- [x] Añadir `<select id="v_inputNicho">` en sección "Nuevo video" (antes del textarea)
- [x] `vCargarNichos()` — fetch('/nichos') al cargar la página, rellena el select dinámicamente
- [x] `vAplicarDefaultsNicho()` — al cambiar nicho, aplica defaults de voz y tts
- [x] Enviar `nicho` en el body del `POST /generar`

**Archivos modificados:** `public/creacion_de_contenido.html`

**Riesgo:** MEDIO — coordinar con el endpoint `/nichos` del backend.

---

### ✅ Fase 6 — Audio: defaults por nicho
**Objetivo:** Si no se especifica voz/TTS, usar los defaults del nicho.

**Completado en Fase 2** — ya implementado en `server.js` líneas 104-109:
```js
const vozFinal  = genero || nichoConfig.defaults.voz || 'femenino';
const ttsFinal  = tts    || nichoConfig.defaults.tts || 'google';
// ídem para modelo, api, estilo, escenario
```

**Riesgo:** NINGUNO — lógica additive, no reemplaza nada.

---

## Nichos disponibles
| ID | Nombre | Estado |
|----|--------|--------|
| `motivacion` | Motivación | ✅ Listo (config + prompts) |
| `curiosidades` | Curiosidades | ✅ Listo (config + prompts) |
| `filosofia` | Filosofía | ✅ Listo (config + prompts) |
| `misterio` | Misterio | ✅ Listo (config + prompts) |
| `ia_tecnologia` | IA y Tecnología | ✅ Listo (config + prompts) |
| `historia` | Historia | ✅ Listo (config + prompts) |
| `guerra` | Guerra | ✅ Listo (config + prompts) |
| `salud_ejercicio` | Salud y Ejercicio | ✅ Listo (config + prompts) |
| `salud_alimentacion` | Alimentación y Recetas | ✅ Listo (config + prompts) |

---

## Notas técnicas importantes
- `storyboard.js` tiene "motivational" hardcodeado en el prompt del sistema (línea 22). Cambiar en Fase 5.
- `imagenes.js:generarTodosPrompts` tiene "dolor inicial → quiebre → esfuerzo → triunfo" hardcodeado (línea ~369). Cambiar en Fase 5.
- `imagenes.js:generarPromptVisual` tiene "videos motivacionales" hardcodeado (línea ~36). Cambiar en Fase 5.
- Al pasar `nichoConfig` a funciones con muchos parámetros, usar objeto en lugar de parámetro adicional (ver Fase 5).
- Compatibilidad: si no se manda `nicho` en el request, usar `'motivacion'` como default en todo el pipeline.

---

## Sesiones

### Sesión 1 — 2026-04-04
**Completado:** Fase 1 (estructura nichos + loader + utils/prompts) + Fase 7 (historial extendido)

**Archivos creados:**
- `nichos/motivacion/` — config.json + 5 prompts .txt
- `nichos/curiosidades/` — config.json + 5 prompts .txt
- `services/nichos.js` — listarNichos(), cargarNicho(id)
- `utils/prompts.js` — renderPrompt(), joinHashtags()
- `utils/historial.js` — comentario extendido (sin cambio funcional)

**Estado al cerrar:** Pipeline intacto, nada roto. Toda la infraestructura de nichos lista pero desconectada.

---

### Sesión 2 — 2026-04-04
**Completado:** Fase 2 — server.js conectado al sistema de nichos

**Archivos modificados:**
- `server.js` — import nichos, endpoint GET /nichos, nicho en pipeline, defaults fusionados, historial extendido

**Estado al cerrar:** Pipeline funcional. El nicho viaja por todo el flujo. Los servicios aún no lo usan (lo ignoran). Sin regresión.

---

### Sesión 3 — 2026-04-04
**Completado:** Fase 3 — services/guion.js refactorizado

**Archivos modificados:**
- `services/guion.js` — nueva firma `generarGuion(tema, id, nichoConfig)`, prompts leídos de nichoConfig, renderizados con renderPrompt, rol/system colapsado al prompt de usuario (template ya incluye el rol)

**Estado al cerrar:** guion.js ya no tiene texto motivacional hardcodeado. Usa los prompts del nicho. Pipeline compatible: server.js ya pasaba nichoConfig como tercer argumento desde Fase 2.

---

### Sesión 4 — 2026-04-04
**Completado:** Fase 4 — services/caption.js refactorizado

**Archivos modificados:**
- `services/caption.js` — nueva firma `generarCaption(guion, nichoConfig)`, prompt leído de nichoConfig, hashtags convertidos con joinHashtags()

**Estado al cerrar:** caption.js sin texto hardcodeado. Usa prompt y parámetros del nicho. Compatible con server.js (ya pasaba nichoConfig).

---

### Sesión 5 — 2026-04-04
**Completado:** Fase 5 — imagenes.js + storyboard.js refactorizados + endpoints util arreglados

**Archivos modificados:**
- `services/storyboard.js` — nueva firma con nichoConfig, usa prompt-storyboard.txt vía renderPrompt
- `services/imagenes.js` — generarPromptVisual, generarTodosPrompts, generarImagenes, generarImagenesSecuencial actualizados con nichoConfig
- `server.js` — /util/guion, /util/imagenes, /util/audio arreglados (cargan nichoConfig='motivacion')

**Estado al cerrar:** App completamente funcional. Todo el pipeline usa nichoConfig. Sin texto hardcodeado en ningún servicio. Los endpoints util funcionan con motivacion por defecto.

---

### Sesión 6 — 2026-04-04
**Completado:** Fase 8 — selector de nicho en el frontend

**Archivos modificados:**
- `public/creacion_de_contenido.html` — select#v_inputNicho, vCargarNichos(), vAplicarDefaultsNicho(), nicho en body del POST

**Estado al cerrar:** El frontend carga los nichos dinámicamente desde /nichos. Al cambiar nicho aplica defaults de voz/tts. El campo nicho viaja en el POST /generar.

**Próxima sesión empieza en:** Fase 6 (audio defaults por nicho en server.js) — última fase
