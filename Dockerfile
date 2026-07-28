# syntax=docker/dockerfile:1

# ---- Stage 1: wasm (runs on the build host's native arch; output is
# architecture-independent) ----
FROM --platform=$BUILDPLATFORM rust:1-slim AS wasm
ARG WASM_PACK_VERSION=0.13.1
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN rustup target add wasm32-unknown-unknown \
    && WASM_PACK_ARCH="$(case "$(uname -m)" in \
         x86_64) echo x86_64-unknown-linux-musl ;; \
         aarch64) echo aarch64-unknown-linux-musl ;; \
         *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;; \
       esac)" \
    && curl -fsSL "https://github.com/wasm-bindgen/wasm-pack/releases/download/v${WASM_PACK_VERSION}/wasm-pack-v${WASM_PACK_VERSION}-${WASM_PACK_ARCH}.tar.gz" \
       | tar -xz --strip-components=1 -C /usr/local/bin --wildcards '*/wasm-pack'
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY core ./core
RUN wasm-pack build core --target web

# ---- Stage 2: web build (native arch; output is architecture-independent) ----
FROM --platform=$BUILDPLATFORM node:22-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
COPY --from=wasm /src/core/pkg /src/core/pkg
RUN npm ci
COPY web ./
RUN npm run build

# ---- Final stage: static serving, per target arch, unprivileged ----
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web /src/web/dist /usr/share/nginx/html
EXPOSE 8080
