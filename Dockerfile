FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run check && npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production PORT=5000 UPLOAD_DIR=/app/uploads
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && mkdir -p /app/uploads && chown node:node /app/uploads
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
USER node
EXPOSE 5000
CMD ["node", "dist/server.js"]
