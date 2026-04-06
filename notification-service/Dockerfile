FROM node:20-alpine

WORKDIR /app

# Mirror repo structure so relative imports work
COPY shared/ ./shared/
COPY notification-service/ ./notification-service/

WORKDIR /app/notification-service
RUN npm install

# Symlink node_modules to parent so shared/ code can resolve express types
RUN ln -s /app/notification-service/node_modules /app/node_modules

RUN npx tsc

CMD ["node", "dist/notification-service/src/index.js"]
