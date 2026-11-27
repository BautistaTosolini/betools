# betools

App de escritorio para Linux que reúne en una sola ventana varias sesiones de [Claude Code](https://code.claude.com/docs) en paralelo, agrupadas por cliente o proyecto.

Cada sesión corre el `claude` CLI real. Se conservan los slash commands, las skills, los permisos, los MCP y los plugins, y betools agrega encima:

- una vista legible de la conversación;
- los archivos que Claude escribió;
- un editor de Markdown;
- variables de entorno por carpeta y por sesión.

> Las capturas usan datos ficticios: los clientes (Acme, Initech), las sesiones, las variables y la conversación son inventados.

![Vista Rendered de una sesión](docs/screenshots/rendered.png)

## Qué hace

### Sesiones agrupadas por carpeta y con sus tickets

- La barra lateral agrupa las sesiones por carpeta (un cliente o un proyecto, con su color) y muestra el estado de cada una: trabajando, necesita tu respuesta o terminó.
- Cada sesión muestra su ticket de Jira como etiqueta, teñida con el color de la carpeta. El título sigue el formato `<TICKET> [<TICKET>…] <resumen>`; por ejemplo, `ACME-118 ACME-121 nightly ETL retries` muestra dos etiquetas y el resumen debajo. El primer ticket es el principal y aparece también en el encabezado de la sesión.
- El título se edita con doble clic en la sesión, o se lee de `~/.claude/tab-titles/<id de sesión>` si un hook lo escribe ahí. Sin título, se usa el de `/rename` o el que genera Claude.

<img src="docs/screenshots/sidebar.png" alt="Barra lateral con carpetas, sesiones y sus tickets" width="320">

- Las sesiones se restauran al reiniciar la app o la PC (`claude --resume`).
- Se puede importar una sesión que se abrió fuera de betools.
- `Ctrl+1…9` y `Ctrl+Tab` cambian de sesión (el número de cada una aparece al pasar el mouse).

### Rendered, Terminal y CLI

Cada sesión tiene tres pestañas:

- **Rendered**: la conversación con formato. Incluye el texto, el razonamiento, las herramientas con su resultado y los bloques de código. Desde ahí se escribe, se adjunta y se responde.
- **Terminal**: una shell en la carpeta de la sesión, con las variables de la sesión.
- **CLI**: la TUI de Claude Code tal cual, para lo que haga falta.

A la derecha de las pestañas están los botones **Variables** (las variables de la sesión) y **▶ Commands** (los comandos guardados).

La barra superior muestra el modelo, el uso del contexto, los límites de 5 horas y semanal del plan y los tokens del día.

### Buscar con Ctrl+F

`Ctrl+F` busca en la conversación de Rendered y en los `.md`, tanto al leerlos como al editarlos (en Visual y en Source). Enter va a la siguiente coincidencia, Shift+Enter a la anterior y Esc cierra. No busca en los comandos ni en los resultados de las herramientas de Claude, y en Rendered busca en los mensajes cargados (para los anteriores, "Show earlier messages"). En las pestañas Terminal y CLI, `Ctrl+F` sigue yendo al proceso.

![Buscador en la conversación](docs/screenshots/find.png)

### Permisos y preguntas sin ir a la terminal

Los pedidos de permiso, las preguntas de Claude (AskUserQuestion) y los formularios de los MCP aparecen en Rendered con sus opciones. Se responden con un clic, con el número o escribiendo qué hacer en lugar de eso.

![Permiso pedido por Claude en Rendered](docs/screenshots/permission.png)

### Paneles de Claude Code

`/config`, `/usage`, `/model`, `/mcp`, `/permissions`, `/resume` y el resto de los paneles de la CLI se dibujan en Rendered. Se navegan con clic o con el teclado, y cada atajo tiene su botón.

![Panel /config en Rendered](docs/screenshots/panel.png)

### Artefactos y editor de Markdown

- El panel de la derecha lista los archivos que Claude creó o editó en la sesión.
- Los `.md` se abren en una pestaña propia y se editan de dos formas:
  - **Visual**: sobre el documento renderizado, como en Notion. Al guardar, lo que no se tocó queda igual byte a byte y solo se reescribe el párrafo o el ítem editado.
  - **Source**: la fuente a la izquierda y la vista previa en vivo a la derecha.
- En los dos modos funcionan `Ctrl+B` (negrita), `Ctrl+I` (cursiva), `Ctrl+E` (código), `Ctrl+Shift+X` (tachado), `Ctrl+K` (link, con la URL seleccionada o copiada) y `Ctrl+S` (guardar). El mismo atajo saca el formato.
- Si Claude cambia el archivo mientras lo editas, betools no lo pisa: avisa y te deja elegir qué versión conservar.

![Edición visual de un Markdown](docs/screenshots/markdown-visual.png)

![Edición de la fuente con vista previa](docs/screenshots/markdown-source.png)

### Variables de entorno

Cada carpeta y cada sesión pueden tener variables que llegan al proceso de Claude. El diálogo de una sesión las muestra divididas: primero las de la carpeta y después las de la sesión, que tienen prioridad (sirven para pisar una de la carpeta; la de la carpeta queda tachada). El de una carpeta muestra además las variables propias de cada sesión de la carpeta, marcando cuáles la pisan. Las variables se pueden mover entre la sesión y su carpeta. Hay tres tipos:

- **Visible**: no es secreta (p. ej. `AWS_PROFILE`). Se guarda en texto plano y se muestra.
- **Encrypted local**: se cifra con el llavero del sistema y nunca se muestra; solo se puede reemplazar o borrar.
- **Secrets Manager o SSM**: se guarda solo la referencia y el valor se lee al arrancar la sesión. Sirve para las credenciales de clientes, que no deben quedar guardadas en la máquina.

![Variables de entorno de una sesión](docs/screenshots/env-vars.png)

### Comandos guardados

Comandos que se corren con un clic desde **▶ Commands**, en la pestaña Terminal de la sesión y con sus variables (p. ej. `aws sso login --profile $AWS_PROFILE`). Pueden ser **globales**, que se ofrecen en todas las sesiones, o **de una carpeta**, que se ofrecen en sus sesiones. Cada uno se puede mover entre global y cualquier carpeta desde "Edit commands…". No van secretos en el comando: se usan variables (`$NOMBRE`).

![Menú de comandos de la carpeta y globales](docs/screenshots/commands-menu.png)

![Comandos de la carpeta y globales](docs/screenshots/commands.png)

## Instalación

Requisitos:

- Linux con `apt` (se empaqueta como `.deb`);
- Node.js;
- el CLI de [Claude Code](https://code.claude.com/docs) instalado y con sesión iniciada.

```bash
npm install
npm run dist
sudo apt install "$PWD/dist/betools_<versión>_amd64.deb"
```

Antes de instalar una versión nueva, cierra betools desde el ícono de la bandeja (Quit).

## Desarrollo

```bash
npm run dev          # la app con recarga en caliente
npm run typecheck
npm test             # Vitest
npm run test:e2e     # Playwright sobre la app compilada, con un "claude" falso
```

Las pruebas e2e usan un HOME, una carpeta de datos y un `claude` falsos (`test/e2e/fake-claude.mjs`): no tocan `~/.claude` ni llaman a ningún modelo.

Para regenerar las capturas de este README con los mismos datos ficticios:

```bash
npm run build && README_SHOTS=1 npx playwright test -c test/e2e/playwright.config.ts readme-shots
```

El diseño, las decisiones y el historial de versiones están en [PLAN.md](PLAN.md).
