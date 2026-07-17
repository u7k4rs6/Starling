# packages/relay has zero runtime dependencies (package.json's own
# "dependencies" is {} — ARCH's "relay ignorance" boundary, DECISIONS
# #0019, means it never even imports the crdt package, let alone anything
# from npm) — a container for it is unusually small: no `npm install`
# stage, no node_modules to copy, just Node plus the compiled output.
#
# Build from the *repository root* (needed for the tsc -b composite
# project reference to packages/relay's own tsconfig): docker build -f
# packages/relay/Dockerfile -t starling-relay .
FROM node:22-slim AS build
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json tsconfig.base.json ./
COPY packages/relay/package.json packages/relay/tsconfig.json packages/relay/
COPY packages/relay/src packages/relay/src
COPY packages/relay/scripts packages/relay/scripts
RUN corepack enable && pnpm install --frozen-lockfile --filter @starling/relay...
RUN npx tsc -p packages/relay/tsconfig.json

FROM node:22-slim
WORKDIR /app
COPY --from=build /repo/packages/relay/dist ./dist
COPY --from=build /repo/packages/relay/scripts ./scripts
COPY --from=build /repo/packages/relay/package.json ./package.json
ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "scripts/serve.mjs"]
