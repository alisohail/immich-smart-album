# Dockerfile for immich-smart-album
FROM node:lts-alpine AS builder
WORKDIR /app
COPY app/ ./
RUN npm ci && npm run build

FROM node:lts-alpine AS runner
WORKDIR /app
COPY --from=builder /app ./
RUN npm ci --omit=dev
ENV NODE_ENV=production
CMD ["node", "dist/main.js"]