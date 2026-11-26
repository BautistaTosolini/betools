# Migración de betools a Rust

Rama: `feat/rust`. La app Electron sigue siendo la versión principal hasta que la versión Rust pase todos los criterios de paridad de este documento.

## Objetivo

Reemplazar Electron y Node por Rust en todo lo que no sea interfaz, con el mismo comportamiento que hoy:

- **Más rápida y más liviana:** sin Chromium ni Node empaquetados; un solo binario nativo por app.
- **Mismo comportamiento:** cada canal de IPC, cada archivo de datos y cada atajo funcionan igual. Un usuario que instala la versión Rust encima de la Electron no pierde sesiones, carpetas, variables, secretos, borradores ni zoom.

## Qué cambia y qué no

| Parte | Hoy | Después |
|---|---|---|
| Proceso principal (`src/main/*`) | Electron + Node | Rust (crates en `crates/`) |
| Ventana, bandeja, autoarranque, portapapeles, diálogos | Electron | Tauri 2 (`src-tauri/`) |
| PTY | `node-pty` | `portable-pty` |
| Preload (`window.clawhip`) | `contextBridge` | `src/renderer/src/tauri-api.ts`, misma API exacta sobre `invoke`/`listen` |
| Interfaz (`src/renderer`) | React + xterm.js | **Sin cambios.** Sigue en TypeScript: es la única forma de mantenerla idéntica |
| Versión web (`web/server`) | Node + `ws` | Rust (`crates/web-server`, axum), mismo protocolo WebSocket que `web/client/ws-api.ts` |
| Paquete | `electron-builder` `.deb` | `tauri build` `.deb` |

## Arquitectura

```
crates/
  types/        structs serde equivalentes a src/shared/types.ts (mismo JSON)
  pty/          pty-manager, shell-manager, status-tracker
  transcripts/  transcript-parser, transcript-watcher, usage, titles
  store/        session-store, settings, migrate, discover, claude-paths, slash-commands, artifact-opener
  secrets/      env-core, secretos locales (compatibles con safeStorage de Electron), master-secrets de la web
  app/          lógica de src/main/index.ts: despachador de canales (`invoke(channel, args)`, `send(channel, args)`)
                y eventos hacia la interfaz a través de un trait `Host` (emitir evento, portapapeles, diálogo,
                abrir URL, notificación). Lo usan la app de escritorio y la web.
  web-server/   binario axum: archivos estáticos + /ws con el protocolo actual
src-tauri/      app de escritorio: implementa `Host` con Tauri, ventana, bandeja, instancia única, --hidden
```

### Contrato con la interfaz

- La interfaz llama `window.clawhip.<método>` igual que hoy (`src/preload/index.ts` es la referencia).
- `tauri-api.ts` traduce cada método al mismo nombre de canal (`sessions:list`, `pty:input`…) con un comando Tauri genérico `ipc_invoke(channel, args)` / `ipc_send(channel, args)`.
- Los eventos (`pty:data`, `session:status`, `conversation:changed`…) llegan como un evento Tauri `ipc` con `{channel, args}`.
- `setZoomFactor` usa el zoom del webview de Tauri. El portapapeles va por Rust (`arboard`), como hoy va por el proceso principal.

### Compatibilidad de datos

- Directorio de datos: el mismo `userData` de Electron, `~/.config/betools/`. Mismos archivos y formato: `sessions.json`, `settings.json`, `secrets.json`, `openers.json`, `plan-limits.json`, `status/`.
- `secrets.json`: hoy cifrado con `safeStorage` de Electron (formato `os_crypt` de Chromium, prefijos `v10`/`v11`, AES-128-CBC con clave PBKDF2 derivada de la contraseña guardada en el llavero por libsecret). La versión Rust lee y escribe ese mismo formato con la misma clave del llavero.
- `localStorage` de la interfaz (borradores, zoom, pestañas de documentos, preferencias): está en el LevelDB de Chromium (`~/.config/betools/Local Storage/leveldb`). En el primer arranque, la app Rust lo importa al almacenamiento del webview de Tauri.
- Autoarranque: la entrada `.desktop` apunta al binario nuevo con `--hidden`.

## Requisitos del sistema (Linux)

Tauri usa WebKitGTK como webview. Paquetes ([fuente](https://v2.tauri.app/start/prerequisites/#linux)):

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev libsecret-1-dev webkit2gtk-driver
```

`webkit2gtk-driver` es para las pruebas e2e con `tauri-driver` ([fuente](https://v2.tauri.app/develop/tests/webdriver/)).

## Riesgo principal

WebKitGTK no es Chromium. Hay que verificar que xterm.js, fuentes, portapapeles, zoom, arrastre y atajos (Ctrl+C/Ctrl+Shift+C, Esc) se comporten igual. Si algo no puede igualarse, se documenta acá antes de reemplazar la versión Electron.

## Fases

1. **Tipos** (`crates/types`): base común para todos los crates.
2. **Port en paralelo** (`pty`, `transcripts`, `store`, `secrets`): cada crate porta sus módulos TS y **todas** las pruebas Vitest de esos módulos a `cargo test`, con los mismos fixtures.
3. **App y web** (`crates/app`, `src-tauri`, `tauri-api.ts`, `crates/web-server`).
4. **Paridad**: revisión adversaria módulo por módulo (TS contra Rust), e2e portadas a WebDriver con el mismo `fake-claude.mjs`, y medición de tamaño, memoria y arranque contra la versión Electron.

## Criterios de paridad (para reemplazar Electron)

- Todas las pruebas unitarias portadas pasan con `cargo test`; las 463 de Vitest siguen pasando (la interfaz no cambia).
- Las 28 pruebas e2e pasan contra la app Tauri.
- Una instalación existente abre con sus sesiones, carpetas, variables (incluidas las cifradas), borradores y zoom.
- `.deb`, memoria en reposo y tiempo de arranque menores que la versión Electron (medidos y anotados acá).

## Estado

| Fase | Estado |
|---|---|
| 1. Tipos | pendiente |
| 2. Port | pendiente |
| 3. App y web | pendiente |
| 4. Paridad | pendiente |
