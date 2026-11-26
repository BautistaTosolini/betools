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
| Versión web (`web/server`) | Node + `ws` | Sin cambios por ahora: fuera de alcance de esta migración |
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
                abrir URL, notificación). Lo usa la app de escritorio.
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
3. **App de escritorio** (`crates/app`, `src-tauri`, `tauri-api.ts`).
4. **Paridad**: revisión adversaria módulo por módulo (TS contra Rust), e2e portadas a WebDriver con el mismo `fake-claude.mjs`, y medición de tamaño, memoria y arranque contra la versión Electron.

## Criterios de paridad (para reemplazar Electron)

- Todas las pruebas unitarias portadas pasan con `cargo test`; las 463 de Vitest siguen pasando (la interfaz no cambia).
- Las 28 pruebas e2e pasan contra la app Tauri.
- Una instalación existente abre con sus sesiones, carpetas, variables (incluidas las cifradas), borradores y zoom.
- `.deb`, memoria en reposo y tiempo de arranque menores que la versión Electron (medidos y anotados acá).

## Estado

Auditoría final hecha el 2026-11-26 sobre la rama `feat/rust`.

| Fase | Estado |
|---|---|
| 1. Tipos | hecha: `crates/types`, 13 pruebas |
| 2. Port | hecha: `pty` 68, `transcripts` 191, `store` 117, `secrets` 59 (1 ignorada: necesita llavero real) |
| 3. App de escritorio | hecha: `crates/app` 50 pruebas, `src-tauri` y `src-tauri/core` (12 pruebas), `tauri-api.ts`; compila y se empaqueta a `.deb` |
| 4. Paridad | parcial: revisión adversaria de los cuatro crates hecha, 28 de 28 e2e pasan contra Tauri, mediciones hechas. Faltan los puntos de "Pendientes" |

Resultados de la auditoría:

- `cargo test` por crate (cada uno con su `CARGO_TARGET_DIR`): 13 + 68 + 191 + 117 + 59 + 50 + 12 = 510 pruebas pasan, 0 fallan, 1 ignorada.
- `npx vitest run`: 463 de 463 pasan (14 archivos).
- e2e contra Tauri (`npm run test:e2e:tauri`): 28 de 28, dos corridas seguidas, hechas por la tarea e2e. En esta auditoría no se repitieron (cuestan varios minutos); no hubo cambios en `src-tauri` desde entonces. No se corrió la e2e de Electron: no cambió.
- Pruebas que hoy no tienen equivalente: ver "Pendientes".

### Cómo ejecutar las e2e de Tauri

```bash
sudo apt install webkit2gtk-driver xvfb xclip
cargo install tauri-driver --locked
npm run test:e2e:tauri
```

Variables opcionales: `BETOOLS_BIN` (binario Tauri), `TAURI_DRIVER`, `WEBKIT_DRIVER`, `XVFB`, `E2E_USE_DISPLAY=1` (usa el `DISPLAY` actual en lugar de Xvfb). Una sola prueba: `node --test --test-name-pattern="texto" test/e2e-tauri/app.spec.ts`. Cada prueba usa su propio `HOME`, `--user-data-dir` y el `fake-claude.mjs`, dentro de Xvfb.

Sin `sudo` se puede compilar y probar extrayendo los paquetes: `apt-get download libwebkit2gtk-4.1-dev ... && dpkg -x <deb> <dir>` y apuntando `PKG_CONFIG_PATH` a `<dir>`; igual con `webkit2gtk-driver` y `xvfb` (variables `WEBKIT_DRIVER`, `XVFB`).

### Datos aislados

`--user-data-dir=<dir>` aísla también el webview de Tauri (`<dir>/webview`). La instancia única es por directorio de datos, así una instancia de prueba convive con la real.

## Mediciones

Método:

- Equipo: 12 núcleos, 30 GB de RAM, Linux 7.0, Xvfb 1700x1100 (no se tocó el escritorio del usuario).
- Electron: `dist/betools_0.14.0_amd64.deb` (ya construido, versión 0.14.0), extraído con `dpkg -x` y ejecutado con `--no-sandbox` (el `chrome-sandbox` extraído no tiene setuid). Tauri: `target/betools-desktop/release/bundle/deb/betools_0.14.0_amd64.deb`, mismo procedimiento.
- Cada corrida usa un directorio de datos, `HOME` y carpeta de trabajo nuevos bajo `/tmp`, con una sola sesión de prueba, `eagerStart` activo, `CLAWHIP_CLAUDE_BIN=test/e2e/fake-claude.mjs` y `ANTHROPIC_BASE_URL` muerta. No hay llamadas a la API ni sesiones reales.
- Arranque: tiempo desde el `exec` hasta que `xdotool search --onlyvisible --pid` encuentra una ventana visible del proceso (sondeo cada 20 ms), y hasta que el `fake-claude` registra `start`. Es el arranque con la caché de disco caliente (no se vació la caché de páginas) y con un directorio de datos vacío salvo la sesión. "Ventana visible" no garantiza que la interfaz ya haya pintado.
- Memoria: 20 s después de que el `fake-claude` arranca, suma de `Rss` y `Pss` de `/proc/<pid>/smaps_rollup` de todo el árbol de procesos del arranque. "Sin fake-claude" excluye el `node` del `fake-claude` (unos 52 MB, igual en ambas). No se usó `smem` (no está instalado); `Pss` es lo mismo que reporta.
- 3 corridas por app, alternadas.

Tamaño del paquete:

| | Electron | Tauri |
|---|---|---|
| `.deb` | 102 442 616 B (97,7 MiB) | 7 077 150 B (6,75 MiB) |
| Instalado (extraído) | 279 MB | 18 MB |

Arranque y memoria en reposo (una sesión abierta):

| Corrida | Electron: ventana / fake start (ms) | Tauri: ventana / fake start (ms) |
|---|---|---|
| 1 | 846 / 923 | 288 / 440 |
| 2 | 544 / 622 | 271 / 453 |
| 3 | 568 / 618 | 155 / 251 |

| Memoria (KB) | Electron (7 procesos) | Tauri (4 procesos) |
|---|---|---|
| RSS del árbol, corridas 1-3 | 740 192 / 731 564 / 737 600 | 604 432 / 601 212 / 611 380 |
| RSS sin fake-claude | 688 156 / 679 576 / 685 584 | 552 404 / 549 228 / 559 372 |
| PSS del árbol, corridas 1-3 | 326 428 / 326 502 / 326 229 | 344 851 / 341 282 / 351 559 |

Lectura:

- `.deb`: Tauri pesa 14,5 veces menos. Cumple el criterio.
- Arranque a ventana: Tauri tarda entre 155 y 288 ms contra 544 a 846 ms de Electron. Cumple el criterio.
- Memoria: **el criterio se cumple solo con RSS** (Tauri usa unos 18 % menos, 605 MB contra 736 MB). Con PSS, que reparte las bibliotecas compartidas entre los procesos que las usan, Tauri usa entre 4 % y 8 % **más** (346 MB contra 326 MB). La diferencia se debe a que `WebKitWebProcess` tiene unos 320 MB de RSS y las bibliotecas de WebKitGTK son del sistema (si otra aplicación ya las tiene cargadas, no cuestan memoria adicional); Electron lleva Chromium propio. No se probó con otras aplicaciones WebKitGTK abiertas. Hay que decidir cuál de las dos cifras vale como criterio.
- Una sola sesión y poco historial; la memoria con muchas sesiones o transcripts largos no se midió.

Después de cada corrida se mató el árbol por PID exacto y se comprobó que no quedan procesos de `betools`, `fake-claude` ni Xvfb de la medición.

## Pendientes

Cada ítem se verificó contra el árbol de trabajo actual el 2026-11-26.

**Decisión de paridad**

1. Criterio de memoria: RSS mejora, PSS no (ver "Mediciones"). Dueño: autor del proyecto. Siguiente paso: elegir la métrica, o medir con otras apps WebKitGTK abiertas.

**Cosas por hacer en archivos del repo**

2. `.gitignore`: falta `src-tauri/gen/` (lo genera `tauri-build`; hoy existe `src-tauri/gen/schemas` sin ignorar). Dueño: raíz. Siguiente paso: agregar la línea.
3. `tsconfig.json` raíz: activar `allowImportingTsExtensions` para quitar el `// @ts-ignore TS5097` de `test/e2e-tauri/app.spec.ts` línea 9. Dueño: raíz / e2e.
4. `clean_env` duplicada en `crates/store/src/slash_commands.rs:118` y `crates/pty/src/env.rs:33` (tipos de retorno distintos: `Vec` y `HashMap`). Dueño: `store` y `pty`. Siguiente paso: dejar una sola (en `types` o en un crate común) y que la otra la use.
5. `crates/transcripts/src/claude_paths.rs` y `crates/store/src/claude_paths.rs` duplican la lógica. Si el `store` conserva su copia, debe ordenar los nombres de directorio (ya lo hace con `read_dir_sorted`). Dueño: `store` / `transcripts`. Siguiente paso: unificar.
6. `Cargo.toml` raíz usa el glob `crates/*`. Hoy no hay `crates/target`, pero un `CARGO_TARGET_DIR` relativo dentro de `crates/` lo rompería. Riesgo bajo. Siguiente paso: lista explícita de miembros.
7. `crates/secrets` y `crates/pty`: `ResolvedEnv` está en `betools_pty`; `app` ya compila con ambos, así que no bloquea. Mover a `types` si se quiere desacoplar.

**Reglas para quien llame a los crates (ya cumplidas en `crates/app`, a mantener)**

8. No llamar a `PtyManager`/`ShellManager` desde `on_spawn` ni desde el callback de `StatusTracker` (deadlock). Usar `attach_with` para reenviar el scrollback. Los callbacks de `TranscriptWatcher` no deben llamar a `watch()` de forma síncrona. `SlashCommands::list_full` es bloqueante: desde async va en `spawn_blocking` (ya lo hace `ipc_invoke`).

**Sin cobertura de pruebas o sin probar con datos reales**

9. Sin e2e: bandeja, close-to-tray, notificaciones con clic, diálogo de carpeta, tamaño de ventana 1500x920, instancia única, salida por SIGTERM, autoarranque. Solo compilan o se probaron a mano. En Linux los clics del ícono de bandeja no llegan (limitación de appindicator); el menú con Show lo cubre. Dueño: `src-tauri`. Siguiente paso: probar en un escritorio real con una instancia aislada.
10. Importación de `localStorage` de Electron: probada con fixtures y con el log real (`000003.log`); la ruta de tablas `.ldb` con compresión snappy no se probó con datos reales. Dueño: `src-tauri/core/src/local_storage.rs`. Siguiente paso: probar con un perfil de Electron con más uso.
11. Falta una prueba automática de que `window.clawhip` de `tauri-api.ts` tenga las mismas claves que `src/preload/index.ts` (hoy se verificó a mano y con `typecheck`). Dueño: `tauri-api.ts`.
12. Falta verificar con una instalación real que `secrets.json` cifrado por Electron se descifra con el llavero real (la prueba `real_keyring` está ignorada; `os_crypt` se contrastó con Electron en instancia aislada). Dueño: `crates/secrets`. Siguiente paso: correr `cargo test -p betools-secrets -- --ignored` en una sesión con llavero y una copia de datos de prueba, no los reales.
13. Ni el probe de comandos con el binario `claude` real ni `artifact_opener` (`reveal`, `detached`) se probaron en un escritorio real. Dueño: `store`.
14. Sin datos reales de transcripts del usuario en las pruebas de `transcripts`, `store::discover` y `types` (solo fixtures y casos sintéticos).
15. La versión del `.deb` sale de `package.json` (0.14.0) y el workspace Cargo está en 0.15.0. Dueño: raíz. Siguiente paso: alinear al publicar.
16. Autoarranque: `index.ts` no crea la entrada `.desktop`, solo se usa `--hidden`; sigue igual en Tauri.

**Diferencias de comportamiento conocidas (aceptadas, sin plan de arreglo)**

- Texto: sustitutos UTF-16 sueltos se reemplazan por U+FFFD (Rust no puede representarlos); `pct`/`contextPct` se escriben como `25.0`; los enteros fuera de rango de `f64` pierden precisión como en JS.
- `pty`: `portable-pty` define `SHELL` en el hijo; si falla el `spawn` se muestra `Failed to start ...` y `onExit(1)` (en TS la excepción quedaba sin capturar); tras `kill()` se descarta la salida tardía; `attach` con 0 columnas o filas no falla.
- `transcripts`: `Date.parse` aproximado a RFC 3339; `serde_json` corta el anidamiento en 128 niveles y no acepta `1e999`; tokens negativos cuentan 0; `plan-limits.json` fuera de esquema se trata como vacío; ids con `/` inicial o `..` pueden salirse de la carpeta (los ids reales son UUID).
- `store`: `sessions.json` mal tipado arranca vacío pero ahora se copia antes a `sessions.json.bak` (adición que no está en TS); los campos desconocidos de `sessions.json` se pierden al guardar; el `Exec` del autoarranque usa `current_exe()` (dentro de un AppImage apuntaría al montaje temporal; existe `SettingsStore::with_exec`).
- `secrets`: sin llavero los mensajes de error siguen a Electron (`System encryption is not available.`); con `secrets.json` parcial o corrupto Rust regenera o responde "no se pudo descifrar" en lugar de lanzar un `TypeError`; `aws` no limita el stdout a 1 MiB mientras lee; el truncado de mensajes cuenta caracteres Unicode, no unidades UTF-16.
- e2e en WebDriver: Xvfb sin gestor de ventanas, eventos de teclado y mouse sintéticos, `confirm`/`alert` reemplazados por JS y portapapeles verificado con `xclip`. No cubre atajos del sistema ni los diálogos nativos de WebKit.
