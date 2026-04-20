# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:18-bookworm-slim

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
    && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime-base

ENV NODE_ENV=production
WORKDIR /app

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends p7zip-full libjxl-tools tini \
    && rm -rf /var/lib/apt/lists/*

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
      org.opencontainers.image.description="Dockerized inpx-web fork for fLibrary and .7z collections" \
      org.opencontainers.image.source="https://github.com/AceAsket/inpx-web"

ENV INPX_ENABLE_CONVERSION=true

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends calibre \
    && rm -rf /var/lib/apt/lists/*

FROM runtime-base AS runtime-lite

LABEL org.opencontainers.image.title="inpx-web-lite" \
      org.opencontainers.image.description="Lighter inpx-web image without Calibre conversion support" \
      org.opencontainers.image.source="https://github.com/AceAsket/inpx-web"

ENV INPX_ENABLE_CONVERSION=false
