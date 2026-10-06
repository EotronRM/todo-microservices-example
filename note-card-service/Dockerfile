# --- Build stage: install deps + compile TypeScript ---
FROM oven/bun:1-alpine AS build

WORKDIR /app

# Mirror repo structure so relative imports work
COPY shared/ ./shared/
COPY note-card-service/ ./note-card-service/

WORKDIR /app/note-card-service
RUN bun install --frozen-lockfile

# Symlink node_modules to parent so shared/ code can resolve dependencies
RUN ln -s /app/note-card-service/node_modules /app/node_modules

RUN bunx tsc

# --- Runtime stage: Node.js only ---
FROM node:20-alpine

# Install fonts so sharp/librsvg can render SVG <text> elements
RUN apk add --no-cache fontconfig ttf-dejavu

WORKDIR /app
COPY --from=build /app/note-card-service/dist ./dist
COPY --from=build /app/note-card-service/node_modules ./node_modules

CMD ["node", "dist/note-card-service/src/index.js"]
