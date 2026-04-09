FROM node:20-alpine

WORKDIR /app

# Mirror repo structure so relative imports work
COPY shared/ ./shared/
COPY saga-orchestrator/ ./saga-orchestrator/

WORKDIR /app/saga-orchestrator
RUN npm install

# Symlink node_modules to parent so shared/ code can resolve dependencies
RUN ln -s /app/saga-orchestrator/node_modules /app/node_modules

RUN npx tsc

CMD ["node", "dist/saga-orchestrator/src/index.js"]
