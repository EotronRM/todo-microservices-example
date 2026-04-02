FROM node:20-alpine

WORKDIR /app

# Mirror repo structure so relative imports work
COPY shared/ ./shared/
COPY todo-service/ ./todo-service/

WORKDIR /app/todo-service
RUN npm install

# Symlink node_modules to parent so shared/ code can resolve express types
RUN ln -s /app/todo-service/node_modules /app/node_modules

RUN npx tsc --outDir dist --rootDir .. --esModuleInterop --resolveJsonModule --skipLibCheck --module commonjs --target ES2022

CMD ["node", "dist/todo-service/src/index.js"]
