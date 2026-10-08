# Build via tools/local/verify-gateway-container.mjs --run. The script stages a
# small explicit context so legacy Docker cannot send repository secrets.
# This is a local packaging proof, not a production deployment configuration.
FROM node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c AS node-runtime

FROM node-runtime AS package-manager
RUN npm install --global pnpm@11.9.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/services/integration-gateway/package.json ./apps/services/integration-gateway/package.json
COPY packages/observability-node/package.json ./packages/observability-node/package.json

FROM package-manager AS build
RUN pnpm --filter @customer-service-os/integration-gateway... install --frozen-lockfile --ignore-scripts
COPY apps/services/integration-gateway/tsconfig.json ./apps/services/integration-gateway/tsconfig.json
COPY apps/services/integration-gateway/src ./apps/services/integration-gateway/src
COPY packages/observability-node/index.mjs packages/observability-node/index.d.mts ./packages/observability-node/
RUN pnpm --filter @customer-service-os/integration-gateway build
RUN find apps/services/integration-gateway/dist -name '*.map' -delete

FROM package-manager AS production-dependencies
RUN pnpm --filter @customer-service-os/integration-gateway... install --prod --frozen-lockfile --ignore-scripts

FROM node-runtime AS runtime
WORKDIR /app/apps/services/integration-gateway
COPY --from=production-dependencies /app/node_modules /app/node_modules
COPY --from=production-dependencies /app/apps/services/integration-gateway/node_modules ./node_modules
COPY --from=production-dependencies /app/packages/observability-node/node_modules /app/packages/observability-node/node_modules
COPY --from=production-dependencies /app/packages/observability-node/package.json /app/packages/observability-node/package.json
COPY --from=build /app/packages/observability-node/index.mjs /app/packages/observability-node/index.mjs
COPY --from=build /app/apps/services/integration-gateway/dist ./dist
COPY --from=build /app/apps/services/integration-gateway/package.json ./package.json
ENV HOST=0.0.0.0
USER node
CMD ["node", "dist/bootstrap.js"]
