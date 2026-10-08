# Build via tools/local/verify-edge-container.mjs --run. It stages only the
# reviewed inputs, avoiding a broad repository-root context on legacy Docker.
# This packages the current local-auth service, not a production identity system.
FROM node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c AS node-runtime

FROM node-runtime AS package-manager
RUN npm install --global pnpm@11.9.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/services/edge-api/package.json ./apps/services/edge-api/package.json
COPY packages/observability-node/package.json ./packages/observability-node/package.json

FROM package-manager AS build
RUN pnpm --filter @customer-service-os/edge-api... install --frozen-lockfile --ignore-scripts
COPY apps/services/edge-api/tsconfig.json ./apps/services/edge-api/tsconfig.json
COPY apps/services/edge-api/src ./apps/services/edge-api/src
COPY packages/observability-node/index.mjs packages/observability-node/index.d.mts ./packages/observability-node/
COPY packages/refund-policy/index.mjs packages/refund-policy/index.d.mts packages/refund-policy/releases.json ./packages/refund-policy/
RUN pnpm --filter @customer-service-os/edge-api build
# Keep runtime output compact; the local token CLI is not the server entrypoint.
RUN find apps/services/edge-api/dist -name '*.map' -delete && rm apps/services/edge-api/dist/local-token-cli.js

FROM package-manager AS production-dependencies
RUN pnpm --filter @customer-service-os/edge-api... install --prod --frozen-lockfile --ignore-scripts

FROM node-runtime AS runtime
WORKDIR /app/apps/services/edge-api
# Preserve the existing monorepo-relative policy import and pnpm dependency links.
COPY --from=production-dependencies /app/node_modules /app/node_modules
COPY --from=production-dependencies /app/apps/services/edge-api/node_modules ./node_modules
COPY --from=production-dependencies /app/packages/observability-node/node_modules /app/packages/observability-node/node_modules
COPY --from=production-dependencies /app/packages/observability-node/package.json /app/packages/observability-node/package.json
COPY --from=build /app/packages/observability-node/index.mjs /app/packages/observability-node/index.mjs
COPY --from=build /app/packages/refund-policy/index.mjs /app/packages/refund-policy/index.mjs
COPY --from=build /app/packages/refund-policy/releases.json /app/packages/refund-policy/releases.json
COPY --from=build /app/apps/services/edge-api/dist ./dist
COPY --from=build /app/apps/services/edge-api/package.json ./package.json
ENV HOST=0.0.0.0
USER node
CMD ["node", "dist/bootstrap.js"]
