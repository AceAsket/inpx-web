# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24-bookworm-slim
ARG RUNTIME_IMAGE=debian:bookworm-slim
ARG INPX_SERVER_RUNTIME=rust
ARG FB2CNG_VERSION=v2.1.1
ARG FB2CNG_ARCH=linux-amd64

FROM rust:1.99.1-alpine3.23 AS kindling-build

RUN apk add --no-cache build-base nasm
# Pinned upstream source and locked Rust dependencies; musl avoids a glibc
# version requirement in the standalone Linux and Synology packages.
ADD --checksum=sha256:6b85364aa51c041c2920fade89f2695a3037bda607bb71051df0ca5f25e9d0b3 https://codeload.github.com/ciscoriordan/kindling/tar.gz/refs/tags/v0.45.6 /tmp/kindling.tar.gz
WORKDIR /kindling
RUN tar -xzf /tmp/kindling.tar.gz --strip-components=1 \
    && cargo build --locked --release \
    && strip target/release/kindling-cli \
    && mkdir /out \
    && cp target/release/kindling-cli /out/kindling \
    && cp LICENSE /out/LICENSE.kindling

FROM scratch AS kindling-tools
COPY --from=kindling-build /out/ /

FROM rust:1.99.1-alpine3.23 AS rust-server-build
RUN apk add --no-cache build-base cmake nasm
WORKDIR /src
COPY rust/ ./rust/
COPY package.json ./
COPY server/core/genres/genresText.js ./server/core/genres/
COPY shared/ebook.css shared/app-reset.html ./shared/
RUN cargo build --manifest-path rust/Cargo.toml --locked --release -p inpx-server

FROM rust-server-build AS rust-build
RUN cargo build --manifest-path rust/Cargo.toml --locked --release -p inpx-catalog -p inpx-reader

FROM rust-build AS rust-auth-build
RUN rustup target add wasm32-unknown-unknown \
    && cargo build --manifest-path rust/Cargo.toml --locked --release --target wasm32-unknown-unknown -p inpx-auth-state

FROM scratch AS rust-linux-programs
COPY --from=rust-build /src/rust/target/release/inpx-server /src/rust/target/release/inpx-catalog /src/rust/target/release/inpx-reader /

FROM scratch AS rust-linux-standalone
COPY --from=rust-server-build /src/rust/target/release/inpx-server /

FROM ${NODE_IMAGE} AS build-deps

WORKDIR /app

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --ignore-scripts --no-audit --no-fund

FROM build-deps AS web-source
COPY .babelrc README.md LICENSE.md ./
COPY build/ ./build/
COPY client/ ./client/
COPY server/ ./server/
COPY shared/ ./shared/
COPY rust/catalog/config-fields.json rust/catalog/LICENSE.quickjs ./rust/catalog/
COPY rust/server/app-directory.json ./rust/server/app-directory.json

FROM web-source AS build-node
# Let the locked packaging dependency select and verify its matching base binary.
RUN node -e "require('@yao-pkg/pkg-fetch').need({nodeRange:'node24',platform:'linux',arch:'x64'}).catch(error=>{console.error(error);process.exit(1)})"

COPY --from=rust-auth-build /src/rust/target/wasm32-unknown-unknown/release/inpx_auth_state.wasm /app/rust/target/wasm32-unknown-unknown/release/inpx_auth_state.wasm
COPY --from=rust-build /src/rust/target/release/inpx-server /src/rust/target/release/inpx-catalog /src/rust/target/release/inpx-reader /app/rust/target/release/
RUN npm run build:linux

FROM web-source AS build-rust
COPY --from=rust-server-build /src/rust/target/release/inpx-server /app/rust/target/release/
RUN npm run build:rust -- linux

FROM build-${INPX_SERVER_RUNTIME} AS build-app

FROM ${NODE_IMAGE} AS djxl-tools

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates lzip
COPY build/linux-djxl.js /tools/linux-djxl.js
RUN node /tools/linux-djxl.js /out

FROM ${NODE_IMAGE} AS fb2cng-tools

ARG FB2CNG_VERSION
ARG FB2CNG_ARCH

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates unzip wget \
    && case "${FB2CNG_VERSION}:${FB2CNG_ARCH}" in \
        v2.1.1:linux-amd64) FB2CNG_SHA256="d366b672866a052c87f5b86604969b84da84830ef187b22fb836494762f5c6b8" ;; \
        v2.1.1:linux-arm64) FB2CNG_SHA256="6c2d565aee583402179a3434fd605acaefad2925b0ba57d96dc85cc3f68f44bc" ;; \
        *) echo "Unsupported FB2CNG_VERSION/ARCH: ${FB2CNG_VERSION}:${FB2CNG_ARCH}" >&2; exit 1 ;; \
    esac \
    && wget -O /tmp/fbc.zip "https://github.com/rupor-github/fb2cng/releases/download/${FB2CNG_VERSION}/fbc-${FB2CNG_ARCH}.zip" \
    && echo "${FB2CNG_SHA256}  /tmp/fbc.zip" | sha256sum -c - \
    && unzip /tmp/fbc.zip -d /fb2cng-runtime \
    && chmod +x /fb2cng-runtime/fbc \
    && rm -rf /tmp/fbc.zip /var/lib/apt/lists/*

FROM ${RUNTIME_IMAGE} AS runtime-base

WORKDIR /app

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates p7zip-full webp tini \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /usr/local/bin/.inpx-web --shell /usr/sbin/nologin inpx \
    && mkdir -p /usr/local/bin/.inpx-web /library \
    && chown inpx:inpx /usr/local/bin/.inpx-web

COPY --from=djxl-tools /out/djxl /usr/bin/djxl
COPY --from=djxl-tools /out/djxl-licenses/ /usr/local/share/licenses/djxl/
COPY --from=build-app /app/dist/linux/inpx-web /usr/local/bin/inpx-web
COPY --from=build-app /app/dist/linux/bin/ /usr/local/bin/bin/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/inpx-web \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 12380
VOLUME ["/usr/local/bin/.inpx-web", "/library"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["/bin/bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/${PORT:-12380} && printf 'GET /health HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n' >&3 && head -n 1 <&3 | grep -q '200'"]

ENTRYPOINT ["tini", "--", "/usr/local/bin/docker-entrypoint.sh"]

FROM runtime-base AS runtime

ARG FB2CNG_VERSION

LABEL org.opencontainers.image.title="inpx-web" \
      org.opencontainers.image.description="Dockerized inpx-web fork with fb2cng and MuPDF conversion" \
      org.opencontainers.image.source="https://github.com/AceAsket/inpx-web"

ENV INPX_ENABLE_CONVERSION=true
ENV INPX_CONVERSION_FORMATS=fb2,epub,epub3,kepub,kfx,azw3,azw8,pdf
ENV INPX_FB2CNG_VERSION=${FB2CNG_VERSION}

COPY --from=fb2cng-tools /fb2cng-runtime/fbc /usr/local/bin/fbc
COPY --from=kindling-tools /kindling /usr/local/bin/kindling
COPY --from=kindling-tools /LICENSE.kindling /usr/local/share/licenses/kindling/LICENSE

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
ENV INPX_CONVERSION_FORMATS=fb2,epub,epub3,kepub,kfx,azw3,azw8,mobi,pdf

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

FROM runtime AS runtime-rust

ENV INPX_CONVERSION_FORMATS=fb2,epub,epub3,kepub,kfx,azw3,azw8,mobi,pdf

FROM runtime-rust AS final
