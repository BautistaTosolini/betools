# clawhip — plan

App de escritorio (Linux) para trabajar con varias sesiones de Claude Code en paralelo.

```
┌──────────────┬───────────────────────────────┬──────────────────┐
│ Sesiones     │  Terminal de la sesión         │  Artefactos      │
│ ● infra-ca   │  (claude CLI real, xterm.js)   │  📄 informe.pdf  │
│ ○ gatekeeper │                                │  🌐 reporte.html │
│ ● clawhip    │                                │  📝 PLAN.md      │
│ [+ nueva]    │                                │                  │
└──────────────┴───────────────────────────────┴──────────────────┘
```

## Decisiones tomadas

| Tema | Decisión | Por qué |
|---|---|---|
| Panel central | Terminal embebida con el `claude` CLI real | Mantiene slash commands, skills, permisos, MCP y plugins sin reimplementar nada |
| Stack | Electron + React + TypeScript (Vite) | `node-pty` y `xterm.js` corren en el mismo runtime; es el camino más corto |
| Persistencia | Restaurar con `claude --resume <id>` | Simple. Si se cierra la app o se reinicia la PC, se relanzan las sesiones |

## Arquitectura

```
Electron main (Node)
├── SessionStore      ~/.config/clawhip/sessions.json  (lista de sesiones abiertas)
├── PtyManager        un node-pty por sesión → `claude --resume <id>` en su cwd
├── TranscriptWatcher lee ~/.claude/projects/<cwd-codificado>/<sessionId>.jsonl
│                     → extrae artefactos (tool_use Write/Edit/NotebookEdit)
├── ArtifactOpener    xdg-open / reglas por extensión
└── IPC  ⇄  Renderer (React)
             ├── Sidebar          (lista, estado, nueva, cerrar, renombrar)
             ├── TerminalPane     (un xterm.js por sesión, oculto/visible)
             └── ArtifactsPanel   (lista de archivos de la sesión activa)
```

### Modelo de datos (`sessions.json`)

```json
{
  "sessions": [
    { "id": "<uuid de Claude>", "name": "infra-ca", "cwd": "/home/.../infra",
      "createdAt": "...", "lastActiveAt": "...", "order": 0 }
  ]
}
```

Una sesión solo sale de la lista cuando la cierras explícitamente desde la UI.

### Cómo se obtiene el `sessionId`

- **Sesión nueva:** la app genera un UUID y lanza `claude --session-id <uuid>` en el cwd elegido. Así se conoce el id desde el inicio, sin tener que adivinarlo.
- **Importar una existente:** se lista `~/.claude/projects/*/*.jsonl` (cwd + primer prompt + fecha) y se elige; se lanza con `claude --resume <id>`.
- Verificar en la fase 0 que `--session-id` y `--resume` se comportan como se espera en la versión instalada (2.1.326).

### Artefactos

1. Se hace tail del `.jsonl` de la sesión (chokidar / `fs.watch` + offset).
2. Se toman los `tool_use` con `name` ∈ {Write, Edit, MultiEdit, NotebookEdit} y su `input.file_path`. Se resuelven las rutas relativas con el `cwd` del registro.
3. Se deduplica por ruta y se guarda la última modificación; se marcan los que ya no existen en disco.
4. Opcional (fase 4): también los archivos que se crean con Bash (`> archivo`, scripts de pandoc, etc.), con un watcher del cwd limitado a extensiones "de documento".

Apertura (configurable en `~/.config/clawhip/openers.json`):

| Extensión | Comando por defecto |
|---|---|
| `.html` | `firefox <ruta>` |
| `.pdf`, `.png`, `.docx`, etc. | `xdg-open <ruta>` (el lector predeterminado) |
| `.md`, código | `xdg-open` o el editor que configures (`code`) |

Acciones extra: "mostrar en carpeta" y "copiar ruta".

### Autoarranque

`~/.config/autostart/clawhip.desktop` (opción en la configuración). Al iniciar se relanzan todas las sesiones, pero en modo **lazy**: se levanta el pty solo cuando seleccionas la sesión, para no abrir N procesos `claude` de golpe. Hay un toggle para "levantar todas al iniciar".

## Fases

### Fase 0 — Spike (½ día)
- Validar `claude --session-id`, `claude --resume` y la ubicación y formato del `.jsonl` (cómo codifica el cwd y la forma de los `tool_use`).
- Electron + node-pty + xterm.js corriendo un `claude` en una ventana.
- Riesgo a confirmar: `node-pty` necesita compilarse contra la versión de Electron (`@electron/rebuild`).

**Resultado (2026-11-17) ✅**
- `claude --session-id <uuid>` crea la sesión con ese id; `claude --resume <uuid>` la retoma, incluso desde otro cwd. Existe también `-n/--name`, que sirve para el nombre visible.
- Transcript: `~/.claude/projects/<cwd con todo carácter no alfanumérico → "-">/<sessionId>.jsonl`.
- Artefactos: líneas con `type: "assistant"` → `message.content[]` con `type: "tool_use"`, `name: "Write" | "Edit"` e `input.file_path` absoluto. Cada línea trae `cwd`, `sessionId` y `timestamp`.
- Stack fijado: electron 45.3.4, electron-vite 6, vite 8, node-pty 1.1.0 (recompilado con `@electron/rebuild`), @xterm/xterm 6.
- **Sandbox de Chromium:** en este Ubuntu, Electron aborta con `chrome-sandbox is not configured correctly`. Para desarrollo: `sudo chown root:root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox` (se pierde al reinstalar `electron`). Para el paquete final: un perfil de AppArmor o el `.deb` de electron-builder. No usar `--no-sandbox` de forma permanente.
- `npm audit`: hay una vulnerabilidad *high* en `picomatch` (ReDoS), transitiva y solo de desarrollo. Pendiente de revisar.

**Jitter del scroll (resuelto en la fase 1):** el renderer clásico de Claude Code reescribe el bloque dinámico dentro del scrollback, y xterm.js salta en cada frame. Cada pty se lanza con `CLAUDE_CODE_NO_FLICKER=1` (renderer de pantalla completa en la pantalla alternativa, con scroll propio) y `CLAUDE_CODE_FORCE_SYNC_OUTPUT=1` (frames atómicos DEC 2026).

**Entorno heredado:** si la app se lanza desde una sesión de Claude, hereda `CLAUDE_CODE_CHILD_SESSION` y otras variables, y las sesiones no guardan el transcript. `pty-manager.ts` las quita antes de lanzar cada pty.

### Fase 1 — MVP de sesiones ✅
- Layout de tres columnas con paneles redimensionables.
- Sidebar: nueva sesión (selector de carpeta + nombre), seleccionar, cerrar (con confirmación) y renombrar.
- Un xterm por sesión; al cambiar de sesión no se destruye la terminal, solo se oculta.
- `sessions.json` persistido; al reabrir la app se restauran con `--resume`.

### Fase 2 — Artefactos ✅
- Parser incremental (`transcript-parser.ts`, sin Electron) + watcher por polling de 1 s (`fs.watchFile`, tolera que el `.jsonl` todavía no exista).
- Fuentes: `Write`, `Edit`, `MultiEdit`, `NotebookEdit` y, por heurística, rutas con extensión de documento en comandos `Bash` cuyo mtime es posterior al comando (cubre PDFs/DOCX generados por scripts). Se descartan las operaciones cuyo `tool_result` vino con `is_error` y lo que cae en `~/.claude/projects/` (memoria).
- Limitación de la heurística de Bash: compara contra el mtime *actual*, así que un archivo que solo se leyó pero se modificó después puede aparecer.
- Apertura según `~/.config/clawhip/openers.json` (`.html` → firefox, resto → xdg-open; si el comando falla se usa la app predeterminada). Sin shell: la ruta va como argumento.
- Panel con filtro "Documentos"/"Todos", archivos borrados tachados, "mostrar en carpeta" y "copiar ruta".
- TranscriptWatcher + panel derecho (ícono por tipo, nombre, ruta relativa, hora).
- Abrir con las reglas de la tabla; menú contextual.

### Fase 3 — Calidad de vida ✅
- Estado por sesión con hooks de Claude Code pasados por `--settings` **solo a las sesiones de clawhip** (no se toca `~/.claude/settings.json`). Cada hook agrega una palabra a `~/.config/clawhip/status/<id>.status`: SessionStart→idle, UserPromptSubmit/PostToolUse→working, Notification(permission_prompt|elicitation_dialog)→waiting, Notification(idle_prompt)→corrige working colgado, Stop→done.
- Pendiente de verificar con uso real: el payload de `Notification` (se busca `permission_prompt` en el JSON de stdin).
- Notificaciones del sistema para waiting/done si no estás mirando esa sesión; clic → abre la sesión.
- Importar sesiones de `~/.claude/projects` (título: custom-title > ai-title > primer prompt).
- Bandeja: la X oculta la ventana (configurable); "Salir" desde la bandeja termina las sesiones.
- Autoarranque: `~/.config/autostart/clawhip.desktop` con `--hidden`. En desarrollo ejecuta el último `npm run build`.
- Ctrl+Tab / Ctrl+Shift+Tab, ajustes en ⚙.
- Indicador de estado por sesión: trabajando, esperando input o en reposo. Se puede derivar del último evento del jsonl o con un hook `Stop`/`Notification` de Claude Code que avise a la app.
- Notificación del sistema cuando una sesión termina o pide permiso.
- Importar sesiones existentes.
- Autostart y bandeja del sistema.
- Atajos: `Ctrl+1..9` y `Ctrl+Tab` para cambiar de sesión.

### Fase 4 — Empaquetado ✅ (vista renderizada del transcript: pendiente, opcional)
- `npm run dist` → `dist/clawhip_<versión>_amd64.deb` (electron-builder 26). Se instala en `/opt/clawhip`, con `/usr/bin/clawhip` y la entrada en el menú de aplicaciones.
- El `postinst` instala un perfil de AppArmor (`/etc/apparmor.d/clawhip`): resuelve el sandbox de Chromium en Ubuntu 24+ sin SUID ni `--no-sandbox`.
- `node-pty` va fuera del asar (`asarUnpack`); el ícono va en `extraResources` para que las notificaciones lo lean.
- La versión instalada usa el mismo perfil que la de desarrollo (`~/.config/clawhip`); no pueden correr las dos a la vez.
- Al arrancar, si el autoarranque está activo, se reescribe la entrada para que apunte al ejecutable actual.
- **Riesgo aceptado:** `npm audit` marca `picomatch` (GHSA-fc5q-39xc-vjpf, ReDoS, todas las versiones). Llega por `vite`, corre solo al compilar y no se empaqueta. La única "solución" de npm es bajar `vite` varias majors; no se aplica.
- Verificado: el payload de `Notification` trae `notification_type` (`permission_prompt`, etc.), que es lo que buscan los hooks.

### Fase 4 — Opcional (original)
- Detectar artefactos creados vía Bash.
- Vista de lectura renderizada del transcript (markdown).
- Empaquetado con electron-builder (AppImage / .deb).

## Riesgos y puntos abiertos

- **Formato del `.jsonl`:** es interno de Claude Code y no está documentado como API estable. Puede cambiar entre versiones, así que hay que aislar el parser en un módulo y tolerar campos desconocidos.
- **Reanudar una sesión que estaba a mitad de una tarea:** `--resume` restaura la conversación, pero no la tarea en curso. Lo que estaba ejecutando al apagar se pierde.
- **Recursos:** cada `claude` es un proceso Node (~150–300 MB, a medir en la fase 0). Por eso el arranque es lazy.
- **Sesiones fuera de la app:** si abres la misma sesión desde otra terminal, dos procesos escriben el mismo jsonl. Hay que avisarlo en la UI o, en el mejor caso, documentarlo.

## Estructura del repo propuesta

```
clawhip/
├── package.json
├── electron/        main.ts, preload.ts, pty-manager.ts, session-store.ts,
│                    transcript-watcher.ts, artifact-opener.ts
├── src/             React: App.tsx, Sidebar/, TerminalPane/, ArtifactsPanel/
└── PLAN.md
```

## Carpetas, tickets y estilo (2026-11-17) ✅
- **Carpetas = clientes** (`folders` en `sessions.json`): nombre, color y path. Una sesión pertenece a la carpeta cuyo path contiene su cwd (gana la más específica); las que no caen en ninguna van a "Sin carpeta". El "+" de una carpeta crea la sesión en su path. Las sugerencias salen de `~/workdir/*/clients/*` (sin `archived`).
- **Ticket + resumen:** se leen de `~/.claude/tab-titles/<session_id>` (lo escribe `~/.claude/hooks/warp-tab-title.sh` según la regla de los CLAUDE.md de clientes) con el formato `<TICKET> <resumen>`. Si no hay, se usa `/rename` o el `ai-title` del transcript. Editar desde clawhip (doble clic) escribe ese mismo archivo, así el hook de `resume` de Warp y clawhip coinciden.
- **Estilo:** tarjetas con borde fino sobre fondo casi negro, sin bordes redondeados, encabezados con agarre y menú ⋮, filas con divisores, botones con borde y el principal claro.
- La franja blanca a la derecha de la terminal era la barra de scroll nativa de Chromium en tema claro: `color-scheme: dark` y se oculta la del viewport de xterm.
- Sesiones viejas con cwd en `~/workdir/clients/<cliente>` (estructura anterior) no caen en las carpetas de `~/workdir/infra/clients/<cliente>`.
- **Paneles laterales plegables:** « / » en cada tarjeta; plegados quedan como riel de 44 px. El riel de sesiones tiene un acceso por sesión (color de carpeta + estado). Se recuerda en localStorage.
- **Agrandar carpeta (⤢):** el panel muestra solo esa carpeta, con encabezado propio y "← Todas". Ctrl+1..9 / Ctrl+Tab recorren solo lo visible.
- **Carpetas con varios paths** (`extraPaths`): sugeridos a partir de los cwd de tus sesiones que contienen `/clients/<nombre>`. Menú ⋮ por carpeta: nueva sesión, agrandar, editar, subir/bajar, borrar.

## Variables de entorno, terminal y comandos (2026-11-18) ✅
- **Variables por carpeta y por sesión** (la sesión pisa a la carpeta). Tres tipos:
  - *Visible*: texto plano en `sessions.json`, se muestra (AWS_PROFILE, AWS_REGION…).
  - *Local cifrada*: `safeStorage` (GNOME Keyring) en `~/.config/clawhip/secrets.json` (0600). Solo para valores propios; se niega a guardar si el backend es `basic_text`.
  - *AWS Secrets Manager / SSM*: solo la referencia (perfil, región, id); el valor se lee con el CLI al lanzar y no toca el disco. Botón "Probar" informa solo éxito y largo. Es lo indicado para credenciales de clientes (la política de Craftech no permite guardarlas en el equipo).
- Ningún IPC devuelve valores secretos al renderer. Los valores no van en argumentos del proceso (que son públicos en `/proc/<pid>/cmdline`), solo en su entorno.
- Si hay secretas: `--append-system-prompt` le indica a Claude usarlas solo por nombre y `permissions.deny` bloquea los comandos que vuelcan el entorno. **No es garantía**: un `echo $VAR` puntual no se puede bloquear sin impedir usar la variable.
- Cambiar variables requiere reiniciar la sesión (⋮ → Reiniciar sesión; retoma con `--resume`).
- **Terminal por sesión**: pestaña "Terminal" (Ctrl+`) con el shell del usuario (`$SHELL -l`) en la carpeta de la sesión y con sus variables. Clave de pty `shell:<id>`.
- **Comandos guardados por carpeta** (⋮ → Comandos…), se corren con "▶ Comandos" en la terminal de la sesión. `aws sso login` con `AWS_PROFILE` visible en la carpeta: el token queda en `~/.aws/sso/cache` y lo usan todas las sesiones con ese perfil.
- **Salto de línea:** en la pestaña Claude, Ctrl+Enter y Shift+Enter mandan `\n` (Ctrl+J), que Claude Code toma como nueva línea; la terminal no distingue esas combinaciones de Enter (`\r` = enviar). En la pestaña Terminal no se toca.
- **Procesos huérfanos:** con SIGTERM/SIGINT/SIGHUP Electron salía sin `will-quit` y los `claude` hijos quedaban vivos. Ahora se terminan en el handler de la señal.

## Versión web para Raspberry Pi (2026-11-18) ✅
- `web/`: servidor Node (HTTP + WebSocket, `ws`) y cliente React. Solo sesiones, Claude, terminal y variables (visibles y cifradas). Sin carpetas, tickets ni artefactos. **Sin autenticación**, por decisión del usuario (red aislada).
- Reutiliza de la app de escritorio: `pty-manager`, `shell-manager`, `status-tracker`, `discover`, `claude-paths` y `env-core` (la lógica de variables sin Electron se separó de `secrets.ts`). El cliente instala un `window.clawhip` sobre WebSocket con la misma API que el preload, y reutiliza `TerminalView`, `EnvDialog`/`EnvEditor`, `ImportDialog` y `Kebab`.
- Variables cifradas: AES-256-GCM con clave derivada (scrypt) de `master.key` (Docker secret).
- Docker: `web/Dockerfile` compila para arm64 con buildx **sin QEMU** (node-pty con compilador cruzado en la etapa de build; la etapa final solo hace COPY). Claude Code nativo descargado de `downloads.claude.ai` y verificado con el SHA-256 del manifiesto. El entrypoint registra el usuario con el UID/GID/home de la Pi y baja privilegios con `setpriv`; `TMPDIR=/data/tmp`.
- Probado: servidor local con Node (sesión, variables, Claude, terminal); imagen amd64 equivalente en Docker (usuario, permisos en el home montado, Claude arrancando, `docker stop` limpio); imagen arm64 compilada y binarios verificados como aarch64. **No probado en una Raspberry real.**
