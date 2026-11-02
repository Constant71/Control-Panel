# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# The test suite runs against the mock game: a failing test stops the build, so an auto-update
# never replaces a working panel with a broken one.
RUN npm run build && npm test && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ARG GIT_SHA=unknown
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data PANEL_VERSION=$GIT_SHA
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8080/panel-api/health || exit 1
# Starts as root only to fix /data ownership, then runs as "node" (see docker-entrypoint.sh).
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/server/server/index.js"]
