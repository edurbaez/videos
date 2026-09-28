# ⚠️ AA REVISAR: léelo antes de usar la app

> Qué cambió en las Fases 2–5 (28-sep-2026), qué falta y qué tienes que hacer tú.
> Borra cada punto cuando lo resuelvas. Cuando el archivo quede vacío, bórralo.

---

## 🔴 1. Acciones urgentes (tuyas)

- [ ] **Rotar y borrar la clave `AIzaSy…` comentada en `.env`.** Aunque `.env` esté en `.gitignore`, esa clave ya no debería estar ahí.
- [ ] **Actualizar `axios`**: `npm audit` marca vulnerabilidades altas. Ejecuta `npm audit fix` y luego `npm test`.
- [ ] **Hacer commit de los cambios.** Hay más de 90 archivos modificados sin commitear, y ahora mismo no hay forma de volver atrás.
- [ ] **Probar el frontend en un navegador real.** Solo se revisó el código, no se usó en el navegador. Pruébalo en todas las páginas: shorts, util, curso, largo, galería e historial.
- [ ] **Antes del 23-oct-2026 (fecha en que se retira `gpt-image-1`)**, comprueba que no queda ningún `gpt-image-1` en tus `.env` o scripts externos. El código ya lo trata como alias de `gpt-image-2`.

---

## 🟠 2. Cambios de comportamiento que debes conocer

### Categoría de YouTube por nicho
Antes todos los videos se subían como **27 (Education)**. Ahora cada nicho usa el valor de `youtube.categoria` en su `config.json`:

| Nicho | Categoría |
|---|---|
| motivacion | 22 (People & Blogs) |
| misterio | 24 (Entertainment) |
| ia_tecnologia | 28 (Science & Tech) |
| salud_ejercicio, salud_alimentacion | 26 (Howto & Style) |
| el resto | 27 (Education) |

Si prefieres otra, cámbiala en `nichos/<id>/config.json`.

### Metadatos de YouTube desde archivos
El título, la descripción y los tags ahora salen de `nichos/<id>/prompt-youtube-{titulo,descripcion,tags}.txt`. Los prompts de curso están en `prompts/curso/` y los de video largo en `prompts/largo/`. **Revisa el tono de cada nicho**: los generó la IA.

### Cola de pipelines
- Solo corre **1 generación a la vez** (`MAX_PIPELINES=1`). Las demás esperan en cola.
- El frontend de shorts muestra la posición en la cola. Las demás páginas esperan sin mostrar ningún aviso.
- Mientras un short espera la edición del guion, deja pasar a otros trabajos. Al confirmar el guion puede que tenga que volver a esperar turno.

### Imágenes en paralelo
- La **1.ª imagen** se genera sola y sirve de referencia. Las demás se generan en paralelo: 3 a la vez con OpenAI y 2 con Google.
- La pausa fija de 35 s entre imágenes de Google ya no existe. Ahora la separación entre peticiones la marca `LARGO_SEGUNDOS_ENTRE_IMAGENES` (10 s por defecto).
- **Vigila si empiezan a aparecer errores 429** (límite de cuota). Si pasa, sube esa variable.

### Telegram
El caption se envía **una sola vez**, como pie del video. Si pasa de 1024 caracteres, se envía como mensaje de texto y el video va sin pie.

### Historial
- Ahora guarda shorts, curso y largo, con un máximo de 50 entradas por tipo.
- `GET /historial` devuelve solo shorts. Para ver los demás tipos usa `?tipo=curso`, `?tipo=largo` o `?tipo=todos`.

### Eventos de error (SSE)
- El nombre nuevo es `pipeline_error`.
- Se siguen emitiendo los nombres antiguos (`error_pipeline` en shorts y `error` en util) **de forma temporal**. Cuando actualices los HTML para que escuchen `pipeline_error`, quita los alias en `lib/sse.js` (opción `aliasError`).

### Validaciones nuevas (responden 400)
- `quality` fuera de `low|medium|high` en `/generar` y `/util/imagenes-directas`.
- `api` distinta de `openai`/`google` en `/util/imagenes-directas`.
- Un nicho inválido en `/util/guion` y `/util/imagenes`, que ahora aceptan `nicho` (por defecto `motivacion`).

---

## 🟢 3. Cómo usar lo nuevo

### Tests
```bash
npm test          # node --test, sin dependencias extra (44 tests)
```

### Video automático diario (scheduler)
Viene **desactivado**. Para activarlo:

1. Copia `ideas.example.csv` a `ideas.csv` y rellénalo. El archivo `ideas.csv` está en `.gitignore`.
   ```csv
   nicho,idea_base,prioridad,canal
   motivacion,disciplina matutina,1,motivacion
   ```
   - `prioridad`: 1 es la más alta y 3 la más baja.
   - `canal` es opcional. Tiene que ser un canal de `youtube-channels.json` que ya esté autorizado. Si no lo pones, se usa `youtube.canal` del `config.json` del nicho. Si tampoco está ahí, **el video se genera pero no se sube**.
   - Puedes editar el CSV con Excel abierto sin problema: el estado de qué ideas ya se usaron se guarda en `ideas-estado.json`.
2. En `.env`:
   ```
   SCHEDULER_ENABLED=true
   SCHEDULER_CRON=0 9 * * *
   SCHEDULER_TZ=America/Mexico_City
   ```
3. Cómo se comporta:
   - Sube el video como **no listado** (`unlisted`). Revísalo y publícalo tú a mano.
   - Solo marca la idea como usada si todo termina bien. Si falla, te avisa por Telegram.
   - Si el servidor estaba apagado a la hora programada, lo ejecuta 60 s después de arrancar, **una sola vez al día**. Un intento que falla no se reintenta solo.
   - La tendencia del día sale de Google News y entra en el guion solo como contexto opcional. En los nichos `salud_*` está desactivada (`automatizacion.tendencias: false`).
4. Endpoints:
   - `GET /scheduler/estado`: muestra el estado, la cola, las ideas y la retención.
   - `POST /scheduler/ejecutar`: lanza el video a mano. Solo funciona con `SCHEDULER_ENABLED=true`.

### Limpieza automática de `output/`
- Viene desactivada. Actívala con `OUTPUT_RETENCION_DIAS=30` en `.env`.
- Se ejecuta a las 03:30 y al arrancar. Borra solo por antigüedad, **sin mirar si el video ya se subió**.
- ⚠️ Cuando se borre un video, `/reenviar` dejará de funcionar con él.

### Proteger la app con `API_KEY`
- Con `API_KEY=...` en `.env`, la primera petición que devuelve 401 hace que el frontend te pida la clave. La guarda en localStorage y en una cookie.
- Las páginas HTML y `/youtube/callback` no piden la clave.
- ⚠️ Si hubiera un XSS, podría robar la clave. Además, la clave aparece en la URL de los SSE (`?apiKey=`). Úsala solo en local o en una red de confianza.

### Otras variables nuevas
- `MAX_PIPELINES`: número de generaciones a la vez. Por defecto 1. Súbelo con cuidado, porque las generaciones compiten por la cuota de imágenes y por la CPU que usa FFmpeg.
- `guion.modelo` en el `config.json` del nicho: acepta `gpt-4o` (por defecto) o `gpt-4o-mini` para el borrador del guion.

---

## 🔵 4. Pendientes técnicos (sin hacer)

- [ ] **Logger con niveles e id de trabajo**, para que no se mezclen los logs cuando hay varios pipelines a la vez.
- [ ] **Quitar los alias de eventos de error** (`error_pipeline` y `error`) después de migrar los HTML a `pipeline_error`.
- [ ] **Mostrar la posición en la cola** en las páginas de curso, largo y util (hoy solo lo hace la de shorts).
- [ ] **`generarImagenesDirectas`** sigue recibiendo 8 parámetros sueltos. Pásalos a un objeto de opciones, como ya se hizo con `generarImagenes`.
- [ ] **Probar `gpt-4o-mini` para el borrador** (`guion.modelo`) y comparar costo y calidad antes de adoptarlo.
- [ ] **Retención más inteligente**: borrar solo lo que ya se subió o se envió.
- [ ] **`API_KEY` → cookie de sesión `HttpOnly`** emitida por un endpoint de login, en lugar de guardar la clave en bruto.
- [ ] **Usar la API de YouTube (videos más populares) como fuente alternativa de tendencias.** Se descartó porque no filtra por tema y gasta cuota del canal.
- [ ] **Siguiente revisión periódica de APIs: 14-oct-2026** (ver CLAUDE.md).
- [ ] (Idea) **Hook de pre-commit** que ejecute `npm test`.
