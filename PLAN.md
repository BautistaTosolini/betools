# clawhip — plan

App de escritorio (Linux) para trabajar con varias sesiones de Claude Code en paralelo.

```
┌──────────────┬───────────────────────────────┬──────────────────┐
│ Sesiones     │  Terminal de la sesión         │  Artefactos      │
│ ● api-gw     │  (claude CLI real, xterm.js)   │  📄 informe.pdf  │
│ ○ pipeline   │                                │  🌐 reporte.html │
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
    { "id": "<uuid de Claude>", "name": "api-gateway", "cwd": "/home/.../infra",
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
  - *AWS Secrets Manager / SSM*: solo la referencia (perfil, región, id); el valor se lee con el CLI al lanzar y no toca el disco. Botón "Probar" informa solo éxito y largo. Es lo indicado para credenciales de clientes (no deben quedar guardadas en el equipo).
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

## Renombre a betools (2026-11-18)
- La app de escritorio pasa a llamarse **betools** (paquete `betools`, `/opt/betools`, `/usr/bin/betools`, datos en `~/.config/betools`). La versión web sigue como clawhip.
- `migrate.ts`: en el primer arranque copia `sessions.json`, `settings.json`, `openers.json` y `secrets.json` de `~/.config/clawhip` (no borra la carpeta vieja). El autoarranque `clawhip.desktop` se reemplaza por `betools.desktop`.
- Se eliminó la CLI `betools` anterior (binario en `~/.local/bin`, función del `.zshrc`, `~/.cache/betools`); su configuración quedó en `~/.config/betools-cli-backup/`.

## v0.3.0 — Inglés + barra de consumo

- Toda la interfaz de escritorio (y los mensajes del proceso principal) en inglés.
- Encabezado: modelo y % de contexto de la sesión seleccionada, límites del plan (ventana de 5 h y semanal,
  con hora de reinicio) y tokens de hoy.
  - Modelo, contexto y límites: status line propio pasado con `--settings` que guarda el JSON de Claude Code en
    `<status>.line` y después llama al status line del usuario con `BETOOLS=1` (`src/main/usage.ts`).
    Los límites se guardan en `userData/plan-limits.json`.
  - Tokens de hoy: suma de `message.usage` (input + output + cache write + cache read) de todos los transcripts de
    `~/.claude/projects` con timestamp de hoy, uno por `message.id`. Se recalcula cada 30 s.
- `~/.claude/statusline-command.sh` omite modelo y barra de contexto cuando `BETOOLS=1`.
- La versión web no cambió de funcionalidad; comparte componentes, así que algunos textos quedan en inglés.

## v0.4.0 — Pestaña Rendered + reinicio automático por variables

- Pestañas: **Rendered** (por defecto) → Terminal → CLI. Ctrl+` las recorre (Ctrl+Shift+` al revés).
  - Rendered: conversación de solo lectura desde el transcript (`TranscriptParser.items`), Markdown con `marked`
    saneado con DOMPurify; bloques ```html en iframe aislado (sandbox sin scripts) con tema oscuro forzado.
    Herramientas consecutivas agrupadas en una línea desplegable. Links → navegador del sistema.
  - El proceso de Claude arranca al seleccionar la sesión aunque la pestaña CLI no se vea (terminal oculta con
    `visibility` para medir su tamaño).
- Al agregar, cambiar o borrar una variable se reinician las sesiones afectadas que estén corriendo (la sesión, o
  todas las de la carpeta). Si están `working` o `waiting` (permiso, pregunta, selección), el reinicio queda
  pendiente hasta que Claude termina el turno. Debounce de 1,5 s para cambios seguidos. Solo escritorio.

## v0.5.0 (en curso, sin empaquetar) — UI v2 + trabajo completo desde Rendered

- Tema v2 (`src/renderer/src/theme.css`, se puede quitar borrándolo y su import): Inter empaquetada
  (`@fontsource-variable/inter@5.2.8`), barra de título de 44 px, paneles a altura completa separados por 1 px,
  filas de sesión con punto de estado a la izquierda, tickets teñidos con el color de la carpeta, sin adornos.
- Rendered permite responder: caja de texto que escribe en el mismo proceso de Claude (Enter envía,
  Shift/Ctrl+Enter salto de línea, Esc o Stop interrumpe; varias líneas van como bracketed paste).
- Menús (permisos, AskUserQuestion, selectores): se leen de la pantalla de xterm (`term-registry.ts`,
  `menu-parser.ts`) y se muestran como botones; números, flechas, Enter y Esc funcionan desde la caja.
  Depende del formato de la TUI de Claude Code: si cambia, el parser puede dejar de reconocerlos (queda la pestaña CLI).

## v0.6.0 — Zoom

- Zoom de toda la ventana (`webFrame.setZoomFactor`): Ctrl + / − / 0 y Ctrl+rueda fuera del chat.
- Zoom solo del chat (columna central): Ctrl+Shift + / − / 0 y Ctrl+rueda sobre el chat. En Rendered usa CSS
  `zoom`; en las terminales cambia el tamaño de letra de xterm y reacomoda la grilla del pty.
- Control en la barra de título (muestra el % si no es 100) con − / % (vuelve a 100) / + para cada uno.
- Se recuerda por equipo en localStorage (`zoomApp`, `zoomChat`). Pasos: 50 %–250 %.

## v0.7.0 — Visor de Markdown + logo nuevo

- Los `.md` del panel de artefactos se abren como pestañas cerrables en la columna central (después de
  Rendered / Terminal / CLI). Se recuerdan por sesión (localStorage `docTabs`), se actualizan solas cuando el
  archivo cambia (`doc:watch`, polling de 1 s, hasta 5 MB) y respetan el zoom del chat.
  Cerrar: ×, clic del medio o Ctrl+W (solo con un documento activo). Links a otro `.md` abren otra pestaña.
- `Markdown.tsx`: renderer compartido entre Rendered y el visor.
- Logo: "B" geométrica blanca sobre fondo casi negro con acento ámbar (`resources/icon.svg`); también en la
  barra de título. CSP: `img-src 'self' data:` para el SVG embebido.

## v0.8.0 — Borradores, pegados y varios tickets por sesión

- Borrador de Rendered por sesión (`drafts.ts`, localStorage): no se pierde al cambiar de pestaña, de sesión ni
  al reiniciar. Al pasar a la CLI se mueve al prompt de Claude (sin Enter) y al volver se trae de vuelta
  (se lee la caja del prompt de la pantalla y se vacía con Ctrl+U). Si el prompt tiene un pegado colapsado
  ("[Pasted text #1]") queda en la CLI y Rendered lo muestra en un aviso con "Send it" / "Open CLI".
- Los `<pasted_content>` de tus mensajes se muestran como bloque desplegable "Pasted text".
- Títulos con varios tickets: `<KEY-principal> <KEY> [<KEY>] <resumen>`; un chip por ticket.

## v0.9.0 — Autocompletado, encolados y lo que faltaba en Rendered

- Autocompletado de `/` en Rendered (comandos de Claude Code, skills y comandos propios, del proyecto y de plugins).
  Lista completa desde el mensaje `init` de `claude -p --output-format stream-json`, con la API apuntando a
  `127.0.0.1:9` para que no haya llamada al modelo (sin sesión guardada ni hooks); descripciones desde los
  `SKILL.md`/comandos en disco. Caché de 10 minutos por carpeta. Si el sondeo falla, se usa la lista del disco.
- Menús: elegir una opción mueve el cursor con flechas y confirma (antes mandaba el número, que en algunos menús
  se escribía como texto y se acumulaba, p. ej. "33311"). Bloqueo síncrono tras elegir.
- Mensajes encolados (los que mandás mientras Claude trabaja): se ven al final de Rendered mientras esperan; los
  que Claude toma a mitad del turno (`attachment` `queued_command`) quedan como mensajes tuyos.
- Respuestas a AskUserQuestion (`toolUseResult.answers`) como bloque "You answered Claude's questions".
- Comandos locales (`system`/`local_command`, p. ej. /context) con su salida desplegable.
- Barra de estado en curso ("Harmonizing… (11m 26s · ↓ 57.5k tokens)") leída de la pantalla.

## v0.10.0 — Texto en cascada en Rendered

- Las respuestas nuevas de Claude aparecen palabra por palabra, como en la CLI (`useReveal` en `Markdown.tsx`):
  ritmo fijo en mensajes cortos, se acelera para terminar en ~2 s en los largos. El transcript solo recibe bloques
  completos, así que es una animación del bloque, no streaming real del modelo.
- Solo se anima lo que llega mientras mirás Rendered (no el historial ni lo que llegó en otra pestaña).
  Sin animación con "reducir movimiento". El scroll sigue el final si estabas abajo.

## v0.11.0 — Remote Control en todas las sesiones

- Cada sesión que lanza betools (nueva o con `--resume`) arranca con `--remote-control "<título de betools>"`
  (sin título, sin nombre: Claude lo nombra con la conversación). Así aparece con el ticket en claude.ai/code y
  en la app del teléfono. Probado con `--resume`: la TUI muestra "/remote-control is active".
- Ajuste "Remote Control" (por defecto encendido). Aplica al (re)iniciar cada sesión.
- Doc: https://code.claude.com/docs/en/remote-control (requiere login de claude.ai; en Team/Enterprise un Owner
  lo habilita en la configuración de admin; no funciona con API key ni con ANTHROPIC_BASE_URL propia).
- La versión web no lo activa.

## v0.12.0 — Esc para detener en Rendered y barra de consumo estable

- Esc detiene a Claude (o cierra el menú) desde cualquier parte de Rendered, no solo con el foco en la caja
  vacía. No actúa si el autocompletado está abierto (ahí lo cierra), ni con el foco en otro campo o diálogo.
  Ctrl+C sigue siendo copiar. Se descartó Ctrl+X porque es "cortar".
- La interrupción no dispara el hook Stop (https://code.claude.com/docs/en/hooks#stop): se detecta por la línea
  "[Request interrupted by user" del transcript y la sesión vuelve a "idle" al instante (antes quedaba en
  "working" hasta el aviso de inactividad). En Rendered se muestra como separador "Interrupted by user".
- Límites 5 h / semanal: cada sesión repetía cada 30 s la lectura de su última respuesta, así que una sesión
  quieta pisaba el valor con uno viejo (subía y bajaba). Ahora se combina por ventana (resets_at): dentro de la
  misma ventana solo sube; se ignoran lecturas de una ventana ya vencida; una ventana nueva reemplaza.
- Tokens del día: escaneo cada 10 s (antes 30 s).

## v0.18.0 — Comandos globales, botón de variables y precedencia visible

- Botón Variables junto a ▶ Commands en la sesión. ▶ Commands aparece en todas las sesiones.
- Comandos globales (todas las sesiones) además de los de carpeta. El menú los agrupa por encabezado y en
  "Edit commands…" cada comando se puede mover a Global o a otra carpeta; todo se guarda junto (commands:save).
- Variables de una sesión divididas en "Folder" y "This session": las de la sesión tienen precedencia y la de
  la carpeta que pisan se marca. En una carpeta se ven también las variables propias de cada sesión hija.
- La barra lateral ya no muestra el ^N junto a cada sesión: el atajo Ctrl+N está en el tooltip.
- README con capturas nuevas (comandos, buscador). Pruebas: Vitest 483 y Playwright 43.

## v0.17.1 — El buscador ignora las herramientas

- Ctrl+F en Rendered no busca en las herramientas que usó Claude (comandos, ediciones y resultados).

## v0.17.0 — Buscador, atajos de Markdown y pegado

- Ctrl+F en Rendered y en los .md (al ver y al editar, en Visual y en Source): barra con contador, Enter /
  Shift+Enter, Esc cierra (no llega a Claude). Resaltado con la API de CSS (sin tocar el DOM); en Source, un
  calco detrás del textarea pinta las coincidencias y Esc deja seleccionada la actual. En Terminal/CLI, Ctrl+F
  sigue yendo al proceso. Rendered busca en lo cargado (find.ts, FindBar.tsx).
- Atajos de Markdown en Visual y Source: Ctrl+B, Ctrl+I, Ctrl+E, Ctrl+Shift+X y Ctrl+K (link con la URL
  seleccionada o copiada); el mismo atajo saca el formato (md-shortcuts.ts).
- Barra del documento angosta: los botones no se parten en dos líneas; se recorta la ruta.
- Ctrl+Shift+V en la terminal pegaba dos veces (además corría el "pegar como texto" de Chromium).
- Las pruebas de copiar/pegar usan un portapapeles en memoria: ya no tocan el del sistema.
- Pruebas: Vitest 483 y Playwright 39.

## v0.16.2 — Sin referencias a clientes

- Ejemplos de la interfaz, comentarios, pruebas y fixtures con nombres y tickets ficticios (Acme, Globex,
  OPS-123…) en lugar de clientes reales. README con capturas a pantalla completa, con datos ficticios.

## v0.16.1 — Variables con valores largos

- Diálogo de variables: un valor largo (p. ej. un host de RDS) se corta en varias líneas; antes aplastaba la
  etiqueta "visible" a una letra por línea. Prueba e2e de regresión.

## v0.16.0 — Edición visual de Markdown

- Visor de Markdown: modo Visual (por defecto) para editar sobre el documento renderizado, como en Notion
  (TipTap). El modo Source con vista previa sigue como opción (Visual | Source); se recuerda el último.
- Guardar no reformatea: los bloques e ítems de lista sin cambios quedan byte a byte como estaban; solo se
  reescribe lo editado (md-merge.ts). Los ítems editados usan la viñeta de la lista. Marcadores como
  <Cliente> que el archivo ya usa no se escapan. El front matter no se muestra y se conserva.
- Archivos con bloques HTML, definiciones de links, MDX o CRLF abren en Source con el motivo.
- Pruebas: Vitest 477 y Playwright 34.

## v0.15.0 — Paneles de comandos en Rendered, respuestas escritas y edición de Markdown

- Paneles de comandos con interfaz (/usage, /status, /config, /model, /mcp, /hooks, /memory, /permissions,
  /plugin, /skills, /help, /theme, /resume, /export, /tasks y rewind): Rendered los dibuja con sus colores. Clic
  en una fila mueve el cursor, doble clic la elige, clic en una pestaña la cambia; el teclado va al panel
  (también los buscadores) y cada atajo de la línea de ayuda tiene su botón (panel-nav.ts, TuiPanel.tsx).
- AskUserQuestion: se ven todas las opciones (antes solo "Chat about this", por la línea divisoria). Clic en
  "Type something." ya no rechaza la pregunta: lleva el cursor ahí y lo escrito en la caja es la respuesta.
- Permisos: lo escrito en la caja responde "No" con esa indicación (Tab de la CLI); nunca aprueba por error.
  Los diálogos sin respuesta escrita no mandan el texto y lo avisan.
- Shift+Tab y clic en el modo del pie cambian el modo de permisos; Esc Esc con la caja vacía abre el rewind.
- Visor de Markdown: botón Edit con la fuente a la izquierda y la vista previa en vivo a la derecha; Ctrl+S
  guarda. Escritura atómica que conserva permisos y symlinks. Si el archivo cambió en disco mientras se
  editaba (p. ej. lo editó Claude), no se pisa: aviso con "Load the disk version" o "Keep mine". Lo escrito
  sin guardar sobrevive a cambiar de sesión (src/main/docs.ts, canal doc:write).
- Pruebas: Vitest 467 (pantallas reales de Claude Code 2.1.332 como fixtures) y Playwright 29.

## v0.14.0 — Todo lo de la CLI en Rendered, variables movibles, copiado y pruebas

- Rendered muestra lo que se ve en la CLI mientras Claude trabaja: herramientas con su estado (en curso, ok,
  error) y su resultado, diffs de las ediciones, razonamiento, avisos (duración del turno, recaps, tareas en
  segundo plano, errores de hooks), la zona en vivo (actividad, todos, subagentes) y el pie de la caja de prompt.
- Menús: el de "New MCP server found" (opciones sin número) ahora se puede usar; casillas después del número;
  un mensaje propio que empieza con "1." ya no aparece como opción.
- Scroll: al volver a Rendered desde Terminal/CLI queda abajo (ResizeObserver en lugar de MutationObserver).
- Copiado: en Electron 45 `clipboard` llega undefined al preload, así que copiar/pegar fallaba sin error; ahora
  va por IPC al proceso principal. Terminal/CLI: Ctrl+Shift+C copia, Ctrl+Shift+V pega, Ctrl+C va siempre al
  proceso; OSC 52 (el /copy de Claude Code) llega al portapapeles; clic derecho con selección copia.
- Variables de entorno: se pueden mover entre una sesión y su carpeta en los dos sentidos ("Move to…" y
  "Move here"); el valor cifrado se re-cifra sin pasar por la interfaz y nunca se pierde si algo falla.
- Correcciones: importar sesiones sin ~/.claude/projects, prefijo de HOME por ruta (no texto), transcript
  vaciado, títulos renombrados antes de vigilarlos.
- Pruebas: Vitest (424, HOME temporal por archivo) y Playwright con Electron y un claude falso (21, sin modelo).
  `npm test`, `npm run test:e2e`, `npm run test:all`.

## v0.13.0 — Formularios MCP en Rendered, versión visible y autocompletado más rápido

- Formularios de servidores MCP (elicitation, "MCP server … requests your input"): Rendered los muestra con un
  campo por fila y su valor. Clic despliega las opciones de un campo, elige una opción o alterna un sí/no; los
  campos de texto se escriben en la caja. Accept/Decline navegan hasta los botones de la TUI y confirman.
  El formato de la pantalla se tomó de Claude Code 2.1.332 (menu-parser.ts, parseForm).
- El encabezado muestra la versión instalada (v0.13.0), tomada de package.json al compilar.
- Bloques de código: el borde de `code` se dibujaba por renglón dentro de `pre`; ahora el bloque no lo lleva.
- Autocompletado de "/": lista de comandos propios de Claude Code actualizada desde el binario 2.1.332 (incluye
  los interactivos que no vienen en el init: resume, copy, diff, theme, login…; sin cost, vim, review). Se
  precarga al abrir la sesión: primero la lista instantánea (disco + fija) y después la del init, sin esperarla.
  Sin filtro se ordena alfabéticamente.
