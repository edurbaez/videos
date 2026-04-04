# Plan de refactorización: Multi-nicho

## Estado general
Implementación por fases para pasar de nicho motivacional hardcodeado a sistema multi-nicho.
Orden de implementación elegido para minimizar riesgos (lo que no rompe nada, primero).

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

### ⬜ Fase 3 — Refactorizar services/guion.js
**Objetivo:** Prompts fuera del JS, parametrizados por nicho.

**Pendiente:**
- [ ] Nueva firma: `generarGuion(tema, id, nichoConfig)`
- [ ] Usar `nichoConfig.prompts.guionBorrador` y `nichoConfig.prompts.guionMejora`
- [ ] Renderizar con `renderPrompt(template, { tema, tono, idioma, estructura, palabras_objetivo, nombre_nicho })`
- [ ] Mantener guardado en disco igual

**Archivos a modificar:** `services/guion.js`

**Riesgo:** ALTO — mayor acoplamiento actual. Probar en local antes de confirmar.

---

### ⬜ Fase 4 — Refactorizar services/caption.js
**Objetivo:** Caption parametrizado por nicho.

**Pendiente:**
- [ ] Nueva firma: `generarCaption(guion, nichoConfig)`
- [ ] Usar `nichoConfig.prompts.caption`
- [ ] Renderizar con `renderPrompt(template, { guion, caption_estilo, hashtags_base, cta })`

**Archivos a modificar:** `services/caption.js`

**Riesgo:** BAJO

---

### ⬜ Fase 5 — Refactorizar services/imagenes.js + storyboard.js
**Objetivo:** Quitar lenguaje motivacional hardcodeado de los prompts visuales.

**Pendiente:**
- [ ] `generarPromptVisual` — usar `nichoConfig.imagenes` en lugar de texto fijo
- [ ] `generarTodosPrompts` — ídem
- [ ] `generarImagenes` — nueva firma con `nichoConfig` al final (o como objeto)
- [ ] `generarImagenesSecuencial` — ídem
- [ ] `storyboard.js` — parámetros del nicho en el prompt del storyboard
  - Ahora tiene hardcodeado: "short motivational videos" y arco "pain → turning point → effort → triumph"
  - Debe venir de `nichoConfig.imagenes.arcoNarrativo` y `nichoConfig.imagenes.tipoEscenas`

**Archivos a modificar:** `services/imagenes.js`, `services/storyboard.js`

**Riesgo:** ALTO — prompts visuales son delicados. Probar nicho por nicho.

---

### ⬜ Fase 8 — Frontend (creacion_de_contenido.html)
**Objetivo:** Selector de nicho en el formulario de vídeo.

**Pendiente:**
- [ ] Añadir `<select id="v_inputNicho">` en sección "Nuevo video"
- [ ] Función JS para hacer `fetch('/nichos')` y llenar el select
- [ ] Llamar esa función al cargar la página
- [ ] Enviar `nicho` en el body del `POST /generar`
- [ ] Opcional: al cambiar nicho, autocompletar voz/tts/estilo con los defaults del nicho

**Archivos a modificar:** `public/creacion_de_contenido.html`

**Riesgo:** MEDIO — coordinar con el endpoint `/nichos` del backend.

---

### ⬜ Fase 6 — Audio: defaults por nicho
**Objetivo:** Si no se especifica voz/TTS, usar los defaults del nicho.

**Pendiente:**
- [ ] En `server.js`, antes de llamar `generarAudio`, resolver voz/tts:
  - Si el usuario mandó valor → usar ese
  - Si no → usar `nichoConfig.defaults.voz` y `nichoConfig.defaults.tts`

**Archivos a modificar:** `server.js` (cuando ya esté en Fase 2)

**Riesgo:** NINGUNO — lógica additive, no reemplaza nada.

---

## Nichos disponibles
| ID | Nombre | Estado |
|----|--------|--------|
| `motivacion` | Motivación | ✅ Listo (config + prompts) |
| `curiosidades` | Curiosidades | ✅ Listo (config + prompts) |

## Nichos planificados para agregar después
- `misterio`
- `ia_tecnologia`
- `filosofia`

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

**Próxima sesión empieza en:** Fase 3 (services/guion.js)
