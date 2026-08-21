# syntax=docker/dockerfile:1

# --- build ----------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies so they never reach the runtime image.
RUN npm prune --omit=dev

# --- runtime --------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

RUN apk add --no-cache tini

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY agent.example.yaml ./

# Transcripts are written here; mount a volume to keep them across deploys.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reaps zombies and forwards SIGTERM, so in-flight calls are hung up
# cleanly rather than the process being killed outright.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
