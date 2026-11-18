# clawhip web (Raspberry Pi)

Versión web de clawhip: selector de sesiones, Claude, terminal y variables de entorno. Sin carpetas, tickets ni artefactos. Corre en Docker (arm64) y se usa desde el navegador en la red local.

> **Sin autenticación.** Quien llegue al puerto 8787 puede ejecutar comandos en la Raspberry con tu usuario y usar tu cuenta de Claude. Pensado solo para una red aislada.

## Requisitos de la Pi

- Sistema de **64 bits** (arm64). Claude Code no existe para ARM de 32 bits.
- Docker con el plugin `compose`.
- Claude Code con sesión iniciada en tu usuario (`~/.claude`). El contenedor monta tu home en la misma ruta y usa ese login.

## Opción A: llevar la imagen ya compilada

En la máquina donde se compiló (desde la raíz del repo):

```bash
docker buildx build --platform linux/arm64 -f web/Dockerfile -t clawhip-web:arm64 \
  --output type=docker,dest=dist/clawhip-web-arm64.tar .
scp dist/clawhip-web-arm64.tar web/docker-compose.yml <usuario>@<ip-de-la-pi>:~/clawhip/
```

En la Pi:

```bash
cd ~/clawhip
docker load -i clawhip-web-arm64.tar
openssl rand -base64 32 > master.key && chmod 600 master.key
PUID=$(id -u) PGID=$(id -g) docker compose up -d --no-build
```

## Opción B: compilar en la Pi

Con el repo clonado en la Pi:

```bash
cd web
openssl rand -base64 32 > master.key && chmod 600 master.key
PUID=$(id -u) PGID=$(id -g) docker compose up -d --build
```

Después, abre `http://<ip-de-la-pi>:8787`.

## Qué guarda y dónde

| Qué | Dónde |
|---|---|
| Lista de sesiones y variables visibles | volumen `clawhip-data` → `/data/sessions.json` |
| Variables cifradas | `/data/secrets.json` (AES-256-GCM con una clave derivada de `master.key`) |
| Conversaciones de Claude | tu `~/.claude` (el mismo que usa `claude` en la Pi) |

- **Si pierdes `master.key`, las variables cifradas no se pueden recuperar.** Hay que volver a cargarlas.
- La clave queda en la Pi: no la uses para credenciales de clientes.
- Con `restart: unless-stopped`, el contenedor vuelve a arrancar después de reiniciar la Pi. Las sesiones se retoman con `--resume` al abrirlas.

## Notas

- **La terminal es la del contenedor**, no la de la Pi: trae `git`, `ssh`, `curl`, `python3` y `make`, pero no lo que instalaste en la Pi fuera de tu home. Lo que está en tu home (scripts, `~/.local/bin`, configuración) sí se ve.
- **Portapapeles sin HTTPS:** el navegador no deja leerlo desde la página. Para pegar en la terminal usa **Ctrl+Shift+V** (pegado nativo del navegador); para copiar, selecciona el texto y usa **Ctrl+Shift+C**.
- **Ctrl+Enter / Shift+Enter** cortan línea en el prompt de Claude.
- **Ctrl+`** alterna entre las pestañas Claude y Terminal.
- Para fijar la versión de Claude Code de la imagen: `--build-arg CLAUDE_VERSION=2.1.327`.
- La imagen no actualiza Claude sola (`DISABLE_AUTOUPDATER=1`); para actualizarlo, recompila.
