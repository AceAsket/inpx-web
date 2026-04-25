# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:18-bookworm-slim
ARG FB2CNG_VERSION=v1.2.3
ARG FB2CNG_ARCH=linux-amd64

FROM ${NODE_IMAGE} AS build-deps

WORKDIR /app

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends zip \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --ignore-scripts --no-audit --no-fund

FROM build-deps AS build

COPY . .
RUN npm run build:client && node build/prepkg.js linux

FROM ${NODE_IMAGE} AS prod-deps

WORKDIR /app

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && rm -rf \
        node_modules/@quasar \
        node_modules/@vue \
        node_modules/quasar \
        node_modules/vue \
        node_modules/vue-router \
        node_modules/vuex \
        node_modules/vuex-persist \
        node_modules/localforage \
        node_modules/csstype \
    && npm cache clean --force

FROM ${NODE_IMAGE} AS webp-tools

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends webp \
    && mkdir -p /webp-runtime/bin /webp-runtime/lib \
    && cp /usr/bin/dwebp /webp-runtime/bin/dwebp \
    && ldd /usr/bin/dwebp \
        | awk '{ if ($(NF-1) ~ /^\//) print $(NF-1) }' \
        | sort -u \
        | xargs -I{} cp -L {} /webp-runtime/lib/ \
    && rm -rf /var/lib/apt/lists/*

FROM ${NODE_IMAGE} AS fb2cng-tools

ARG FB2CNG_VERSION
ARG FB2CNG_ARCH

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates unzip wget \
    && wget -O /tmp/fbc.zip "https://github.com/rupor-github/fb2cng/releases/download/${FB2CNG_VERSION}/fbc-${FB2CNG_ARCH}.zip" \
    && unzip /tmp/fbc.zip -d /fb2cng-runtime \
    && chmod +x /fb2cng-runtime/fbc \
    && rm -rf /tmp/fbc.zip /var/lib/apt/lists/*

FROM ${NODE_IMAGE} AS runtime-base

ENV NODE_ENV=production
ENV LD_LIBRARY_PATH=/usr/local/lib
WORKDIR /app

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends p7zip-full libjxl-tools tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=webp-tools /webp-runtime/bin/dwebp /usr/local/bin/dwebp
COPY --from=webp-tools /webp-runtime/lib/ /usr/local/lib/
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package*.json ./
COPY server ./server
COPY build/appdir.js ./build/appdir.js
COPY --from=build /app/dist/public.json ./dist/public.json
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN rm -f server/config/application_env \
    && sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 12380
VOLUME ["/usr/local/bin/.inpx-web", "/library"]

ENTRYPOINT ["tini", "--", "/usr/local/bin/docker-entrypoint.sh"]

FROM runtime-base AS runtime

LABEL org.opencontainers.image.title="inpx-web" \
      org.opencontainers.image.description="Dockerized inpx-web fork with fb2cng and MuPDF conversion" \
      org.opencontainers.image.source="https://github.com/AceAsket/inpx-web"

ENV INPX_ENABLE_CONVERSION=true
ENV INPX_CONVERSION_FORMATS=epub,epub3,kepub,kfx,azw8,pdf

COPY --from=fb2cng-tools /fb2cng-runtime/fbc /usr/local/bin/fbc

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends mupdf-tools fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

FROM runtime AS runtime-calibre

LABEL org.opencontainers.image.title="inpx-web-calibre" \
      org.opencontainers.image.description="Full inpx-web image with fb2cng, MuPDF and Calibre fallback conversion" \
      org.opencontainers.image.source="https://github.com/AceAsket/inpx-web"

ENV QTWEBENGINE_CHROMIUM_FLAGS=--no-sandbox
ENV INPX_CONVERSION_FORMATS=epub,epub3,kepub,kfx,azw8,pdf

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends calibre \
    && find /usr/lib /usr/share -type d -name __pycache__ -prune -exec rm -rf {} + \
    && find /usr/lib /usr/share -type f \( -name '*.pyc' -o -name '*.pyo' \) -delete \
    && rm -rf \
        /usr/share/doc \
        /usr/share/info \
        /usr/share/lintian \
        /usr/share/locale \
        /usr/share/man \
        /usr/share/qt6/translations \
        /usr/share/calibre/quick_start \
        /usr/share/calibre/mathjax \
        /usr/lib/python3.11/test \
    && rm -rf /var/lib/apt/lists/*

FROM runtime-base AS runtime-lite

LABEL org.opencontainers.image.title="inpx-web-lite" \
      org.opencontainers.image.description="Lighter inpx-web image without Calibre conversion support" \
      org.opencontainers.image.source="https://github.com/AceAsket/inpx-web"

ENV INPX_ENABLE_CONVERSION=false
ENV INPX_CONVERSION_FORMATS=

FROM runtime AS final
