# --- Build stage: install deps + type-check + bundle with Vite ---
FROM oven/bun:1-alpine AS build

WORKDIR /app
COPY web/ ./
RUN bun install --frozen-lockfile
RUN bun run build

# --- Runtime stage: nginx serves the bundle and proxies /api to the gateway ---
FROM nginx:1-alpine

# Where /api goes. Compose reaches the gateway on its container port; override
# it where the gateway listens elsewhere (e.g. a Kubernetes Service on port 80).
ENV API_GATEWAY_URL=http://api-gateway:3000

COPY web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
