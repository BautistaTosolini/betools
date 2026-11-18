# syntax=docker/dockerfile:1.7
# clawhip web. Se compila con buildx sin emulación: la etapa "build" corre en la arquitectura de la
# máquina que compila y genera todo para la arquitectura destino (node-pty con compilador cruzado);
# la etapa final no ejecuta nada (solo COPY), así que no hace falta QEMU para arm64.
#
#   docker buildx build --platform linux/arm64 -f web/Dockerfile -t clawhip-web:arm64 .

FROM --platform=$BUILDPLATFORM node:22-bookworm AS build
ARG TARGETARCH
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN if [ "$TARGETARCH" = "arm64" ] && [ "$(dpkg --print-architecture)" != "arm64" ]; then \
      apt-get update && apt-get install -y --no-install-recommends g++-aarch64-linux-gnu && rm -rf /var/lib/apt/lists/*; \
    fi

# Cliente y servidor web (JavaScript, independiente de la arquitectura).
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run build:web

# Dependencias de runtime para la arquitectura destino.
WORKDIR /runtime
COPY web/runtime.package.json package.json
RUN set -e; \
    if [ "$TARGETARCH" = "arm64" ] && [ "$(dpkg --print-architecture)" != "arm64" ]; then \
      export CC=aarch64-linux-gnu-gcc CXX=aarch64-linux-gnu-g++ npm_config_arch=arm64 npm_config_target_arch=arm64; \
    fi; \
    npm install --omit=dev; \
    cp -r /src/web-dist/. /runtime/

# Claude Code nativo para la arquitectura destino, verificado con el SHA-256 del manifiesto oficial.
ARG CLAUDE_VERSION=latest
RUN set -e; base=https://downloads.claude.ai/claude-code-releases; \
    v="$CLAUDE_VERSION"; if [ "$v" = latest ]; then v=$(curl -fsSL "$base/latest"); fi; \
    case "$TARGETARCH" in arm64) p=linux-arm64 ;; amd64) p=linux-x64 ;; *) echo "Arquitectura no soportada: $TARGETARCH" >&2; exit 1 ;; esac; \
    curl -fsSL "$base/$v/manifest.json" -o /tmp/manifest.json; \
    sum=$(node -e "process.stdout.write(require('/tmp/manifest.json').platforms['$p'].checksum)"); \
    curl -fsSL "$base/$v/$p/claude" -o /claude; \
    echo "$sum  /claude" | sha256sum -c -; \
    chmod 755 /claude; echo "Claude Code $v ($p)"

# Imagen final: node:22 completo (git, ssh, curl, python3, make…) para que la terminal sea útil.
FROM node:22-bookworm
COPY --from=build /runtime /app
COPY --from=build /claude /usr/local/bin/claude
COPY --chmod=755 web/docker/entrypoint.sh /usr/local/bin/clawhip-entrypoint
ENV PORT=8787 \
    CLAWHIP_DATA_DIR=/data \
    CLAWHIP_CLAUDE_BIN=/usr/local/bin/claude \
    DISABLE_AUTOUPDATER=1 \
    SHELL=/bin/bash
EXPOSE 8787
STOPSIGNAL SIGTERM
ENTRYPOINT ["clawhip-entrypoint"]
