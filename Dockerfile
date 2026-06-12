# ghcr.io/boardwalk-labs/boardwalk — the self-hosted Boardwalk engine in server mode (SPEC §5).
#
#   docker run -v ./data:/data -p 8080:8080 ghcr.io/boardwalk-labs/boardwalk
#
# ---------------------------------------------------------------------------
# NOTE (pre-publish): this image does NOT build from today's checkout. The
# repo currently overrides @boardwalk-labs/workflow to `link:../boardwalk-sdk`
# (incubation-phase sibling checkout — see package.json "pnpm.overrides"),
# and that sibling is not in the Docker build context. Once @boardwalk-labs/workflow
# is published to the npm registry and the link: override is removed, this
# Dockerfile builds as-is with a plain `pnpm install`.
# ---------------------------------------------------------------------------

# ---- build stage -----------------------------------------------------------
FROM node:24-slim AS build

# Why npm-global pnpm instead of corepack: corepack downloads pnpm at invocation
# time, adding a network fetch (and a moving part) to every build; a pinned
# global install happens once, in this layer.
RUN npm install -g pnpm@10

WORKDIR /app

# Dependency layer first so source edits don't bust the install cache.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# Drop devDependencies; the runtime stage copies production node_modules only.
RUN pnpm prune --prod

# ---- runtime stage ---------------------------------------------------------
FROM node:24-slim

WORKDIR /app

# BOARDWALK_IN_DOCKER selects the /data default for BOARDWALK_DATA_DIR.
# BOARDWALK_HOST=0.0.0.0 is required to reach the server through Docker's port
# mapping — the engine's wider-than-loopback bind warning is expected here and
# fine: the container boundary is the operator's network boundary.
ENV NODE_ENV=production \
    BOARDWALK_IN_DOCKER=1 \
    BOARDWALK_HOST=0.0.0.0

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY bin ./bin
COPY package.json ./

VOLUME /data
EXPOSE 8080

CMD ["node", "bin/boardwalk-server.js"]
