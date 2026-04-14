# ── Stage 1: Build ────────────────────────────────────────────────────────────
# Install all dependencies (including devDependencies) and compile TypeScript.
FROM node:lts-alpine AS builder
WORKDIR /app
COPY app/package*.json ./
RUN npm ci
COPY app/src ./src
COPY app/tsconfig.json ./
RUN npm run build

# ── Stage 2: Run ──────────────────────────────────────────────────────────────
# Start clean — install only production dependencies, then copy compiled output.
# This avoids carrying over devDependencies or source files from the build stage.
FROM node:lts-alpine AS runner
WORKDIR /app
COPY app/package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
ENV NODE_ENV=production
ENV CONFIG_DIR=/config
CMD ["node", "dist/main.js"]