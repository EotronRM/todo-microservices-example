FROM node:20-alpine

# Install fonts so sharp/librsvg can render SVG <text> elements
RUN apk add --no-cache fontconfig ttf-dejavu

WORKDIR /app

# Mirror repo structure so relative imports work
COPY shared/ ./shared/
COPY note-card-service/ ./note-card-service/

WORKDIR /app/note-card-service
RUN npm install

# Symlink node_modules to parent so shared/ code can resolve express types
RUN ln -s /app/note-card-service/node_modules /app/node_modules

RUN npx tsc

CMD ["node", "dist/note-card-service/src/index.js"]
