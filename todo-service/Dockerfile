# --- Build stage: install deps + compile TypeScript ---
FROM oven/bun:1-alpine AS build

WORKDIR /app

# Mirror repo structure so relative imports work
COPY shared/ ./shared/
COPY todo-service/ ./todo-service/

WORKDIR /app/todo-service
RUN bun install --frozen-lockfile

# Symlink node_modules to parent so shared/ code can resolve dependencies
RUN ln -s /app/todo-service/node_modules /app/node_modules

RUN bunx tsc

# --- Runtime stage: Node.js only ---
FROM node:20-alpine

WORKDIR /app
COPY --from=build /app/todo-service/dist ./dist
COPY --from=build /app/todo-service/node_modules ./node_modules

CMD ["node", "dist/todo-service/src/index.js"]
