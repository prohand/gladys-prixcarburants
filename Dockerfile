# -----------------------------------------------------------------------------
# Integration image.
#
# Gladys sandbox constraints ("the sandbox is the defense"):
#   - rootfs mounted READ-ONLY -> never write outside /data
#   - a single writable volume: /data
#   - runs as a non-root user
#   - multi-arch image (linux/amd64 + linux/arm64), see the CI workflow
# -----------------------------------------------------------------------------

# Pinned by digest (multi-arch index of node:24-alpine) so a rebuild of the
# same tag cannot change the runtime under a release; Dependabot's `docker`
# ecosystem bumps the tag and the digest together.
FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80

# dumb-init: handles signals (SIGTERM) correctly for a graceful shutdown.
RUN apk add --no-cache dumb-init

WORKDIR /app

# Install the PROD dependencies first (better build cache).
# `npm ci` only: the lockfile is committed and kept in sync by CI, and falling
# back to `npm install` would silently ship dependencies nobody reviewed.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Then the integration code.
COPY index.js ./
COPY src ./src
COPY gladys-assistant-integration.json ./

# The only writable location allowed at runtime. Created and handed to the
# unprivileged user BEFORE the VOLUME line: a volume declared on a missing
# directory is created root-owned, and the price history (src/priceHistory.js)
# could then never be written.
ENV NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# Run as an unprivileged user (already present in the node image).
USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]
