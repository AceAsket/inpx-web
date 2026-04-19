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

EXPOSE 12380
VOLUME ["/data", "/library"]

ENTRYPOINT ["tini", "--"]
CMD ["node", "server", "--host=0.0.0.0", "--port=12380", "--data-dir=/data", "--lib-dir=/library"]
