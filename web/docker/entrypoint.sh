#!/bin/sh
# Arranca como root solo para registrar el usuario de la Pi (mismo UID/GID/home que el host, así
# los archivos del home montado siguen siendo tuyos) y después baja los privilegios.
set -eu
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
CLAWHIP_USER="${CLAWHIP_USER:-pi}"
CLAWHIP_HOME="${CLAWHIP_HOME:-/home/$CLAWHIP_USER}"

if [ "$(id -u)" = "0" ]; then
  # Grupo
  if getent group "$PGID" >/dev/null; then
    old=$(getent group "$PGID" | cut -d: -f1)
    [ "$old" = "$CLAWHIP_USER" ] || groupmod -n "$CLAWHIP_USER" "$old" 2>/dev/null || true
  else
    groupadd -g "$PGID" "$CLAWHIP_USER"
  fi
  # Usuario (la imagen de node ya trae "node" con UID 1000: se renombra)
  if getent passwd "$PUID" >/dev/null; then
    old=$(getent passwd "$PUID" | cut -d: -f1)
    usermod -l "$CLAWHIP_USER" -d "$CLAWHIP_HOME" -g "$PGID" -s /bin/bash "$old" 2>/dev/null || true
  else
    useradd -u "$PUID" -g "$PGID" -d "$CLAWHIP_HOME" -s /bin/bash -M "$CLAWHIP_USER"
  fi
  # Temporales propios: Claude rechaza /tmp/claude-<uid> si existe y no es del usuario
  # (puede pasar si el home montado vive bajo /tmp).
  mkdir -p "$CLAWHIP_DATA_DIR/tmp"
  chown "$PUID:$PGID" "$CLAWHIP_DATA_DIR" "$CLAWHIP_DATA_DIR/tmp"
  chmod 700 "$CLAWHIP_DATA_DIR/tmp"
  exec setpriv --reuid="$PUID" --regid="$PGID" --init-groups \
    env HOME="$CLAWHIP_HOME" USER="$CLAWHIP_USER" LOGNAME="$CLAWHIP_USER" TMPDIR="$CLAWHIP_DATA_DIR/tmp" \
    node /app/server.mjs
fi
exec node /app/server.mjs
