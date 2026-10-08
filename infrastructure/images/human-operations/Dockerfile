# Build via tools/local/verify-human-operations-container.mjs --run. It stages
# only reviewed inputs; this is local packaging proof, not a deployment recipe.
FROM node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c AS node-runtime

FROM node-runtime AS package-manager
RUN npm install --global pnpm@11.9.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/services/human-operations/package.json ./apps/services/human-operations/package.json
COPY packages/observability-node/package.json ./packages/observability-node/package.json

FROM package-manager AS build
RUN pnpm --filter @customer-service-os/human-operations... install --frozen-lockfile --ignore-scripts
COPY apps/services/human-operations/tsconfig.json ./apps/services/human-operations/tsconfig.json
COPY apps/services/human-operations/src ./apps/services/human-operations/src
COPY apps/services/human-operations/migrations ./apps/services/human-operations/migrations
COPY packages/observability-node/index.mjs packages/observability-node/index.d.mts ./packages/observability-node/
# The local tsconfig is typecheck-only (noEmit: true); emit only inside this build stage.
RUN pnpm --filter @customer-service-os/human-operations exec tsc -p tsconfig.json --noEmit false --rootDir src --outDir dist
RUN find apps/services/human-operations/dist -name '*.map' -delete \
    && rm apps/services/human-operations/dist/local-token-cli.js \
          apps/services/human-operations/dist/local-delivery-token-cli.js \
          apps/services/human-operations/dist/local-support-token-cli.js

FROM package-manager AS production-dependencies
RUN pnpm --filter @customer-service-os/human-operations... install --prod --frozen-lockfile --ignore-scripts

FROM node-runtime AS runtime
WORKDIR /app/apps/services/human-operations
COPY --from=production-dependencies /app/node_modules /app/node_modules
COPY --from=production-dependencies /app/apps/services/human-operations/node_modules ./node_modules
COPY --from=production-dependencies /app/packages/observability-node/node_modules /app/packages/observability-node/node_modules
COPY --from=production-dependencies /app/packages/observability-node/package.json /app/packages/observability-node/package.json
COPY --from=build /app/packages/observability-node/index.mjs /app/packages/observability-node/index.mjs
COPY --from=build /app/apps/services/human-operations/dist ./dist
COPY --from=build /app/apps/services/human-operations/migrations ./migrations
COPY --from=build /app/apps/services/human-operations/package.json ./package.json
ENV HOST=0.0.0.0
USER node
CMD ["node", "dist/bootstrap.js"]
