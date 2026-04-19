FROM node:16-bullseye-slim AS build

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends zip \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build:client && node build/prepkg.js linux

FROM node:16-bullseye-slim

ENV NODE_ENV=production

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends p7zip-full tini \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY server ./server
COPY --from=build /app/dist/public.json ./dist/public.json
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 12380
VOLUME ["/usr/local/bin/.inpx-web", "/library"]

ENTRYPOINT ["tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
