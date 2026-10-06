# --- Build stage: install deps + compile TypeScript ---
FROM oven/bun:1-alpine AS build

WORKDIR /app

# Mirror repo structure so relative imports work
COPY shared/ ./shared/
COPY api-gateway/ ./api-gateway/

WORKDIR /app/api-gateway
RUN bun install --frozen-lockfile

# Symlink node_modules to parent so shared/ code can resolve dependencies
RUN ln -s /app/api-gateway/node_modules /app/node_modules

RUN bunx tsc

# --- Runtime stage: Node.js only ---
FROM node:20-alpine

WORKDIR /app
COPY --from=build /app/api-gateway/dist ./dist
COPY --from=build /app/api-gateway/node_modules ./node_modules

CMD ["node", "dist/api-gateway/src/index.js"]
