# The venue-call-agent dev image (TASK-3748 step 4). Built by cloudbuild.yaml, never by buildpacks:
# the Node version and the user are pinned here, in a reviewed file, instead of resolved on the
# day of the build (docs/DEPLOY.md section 2).
#
# Node 22.18 is the first 22.x that strips TypeScript types by default, so `node src/server/main.ts`
# runs with no build step (.nvmrc, package.json engines). The base is pinned by its multi-arch index
# digest; Dependabot's docker ecosystem proposes the bumps (.github/dependabot.yml).
FROM node:22.18.0-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e

ENV NODE_ENV=production
WORKDIR /app

# The lockfile is honoured exactly, and no package may run an install script.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force \
    # SPIKE (it-22 smaller image): type declarations, source maps and docs are never loaded at runtime.
    && find node_modules \( -name '*.d.ts' -o -name '*.d.cts' -o -name '*.d.mts' -o -name '*.map' -o -name '*.md' -o -name '*.ts.map' \) -type f -delete \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg

# Only the runtime tree. Tests, fixtures, scripts and docs stay out of the image (.dockerignore).
COPY src ./src

# SPIKE (it-22 compile cache): V8's code cache for every module the boot and the cascade load,
# written at build time so a cold instance skips the compile (Node 22.1+ NODE_COMPILE_CACHE).
ENV NODE_COMPILE_CACHE=/app/.node-compile-cache
RUN node --input-type=module -e "await import('./src/server/main.ts'); await import('./src/agent/cascade.ts'); await import('@google-cloud/speech'); await import('google-auth-library');" \
    && chown -R node:node /app/.node-compile-cache && ls /app/.node-compile-cache

# Non-root: the base image's `node` user (uid 1000). The service writes nothing to disk.
USER node

# Cloud Run sets PORT; src/config.ts reads it. SIGTERM drains live calls (src/server/main.ts).
CMD ["node", "src/server/main.ts"]
