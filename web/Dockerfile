# --- Build stage: install deps + type-check + bundle with Vite ---
FROM oven/bun:1-alpine AS build

WORKDIR /app
COPY web/ ./
RUN bun install --frozen-lockfile
RUN bun run build

# --- Runtime stage: nginx serves the bundle and proxies /api to the gateway ---
FROM nginx:1-alpine

COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
