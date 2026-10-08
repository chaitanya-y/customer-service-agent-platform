# Build through tools/local/verify-workflow-container.mjs --run. The script
# stages reviewed inputs; this is a local packaging proof, not a deployment.
FROM node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c AS node-runtime

FROM node-runtime AS package-manager
RUN npm install --global pnpm@11.9.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/services/workflow-workers/package.json ./apps/services/workflow-workers/package.json
COPY packages/observability-node/package.json ./packages/observability-node/package.json

FROM package-manager AS build
RUN pnpm --filter @customer-service-os/workflow-workers... install --frozen-lockfile --ignore-scripts
COPY apps/services/workflow-workers/tsconfig.json ./apps/services/workflow-workers/tsconfig.json
COPY apps/services/workflow-workers/src ./apps/services/workflow-workers/src
COPY packages/observability-node/index.mjs packages/observability-node/index.d.mts ./packages/observability-node/
COPY packages/refund-policy/index.mjs packages/refund-policy/index.d.mts packages/refund-policy/releases.json ./packages/refund-policy/
RUN pnpm --filter @customer-service-os/workflow-workers build

FROM package-manager AS production-dependencies
RUN pnpm --filter @customer-service-os/workflow-workers... install --prod --frozen-lockfile --ignore-scripts

FROM node-runtime AS runtime
WORKDIR /app/apps/services/workflow-workers
COPY --from=production-dependencies /app/node_modules /app/node_modules
COPY --from=production-dependencies /app/apps/services/workflow-workers/node_modules ./node_modules
COPY --from=production-dependencies /app/packages/observability-node/node_modules /app/packages/observability-node/node_modules
COPY --from=production-dependencies /app/packages/observability-node/package.json /app/packages/observability-node/package.json
COPY --from=build /app/packages/observability-node/index.mjs /app/packages/observability-node/index.mjs
COPY --from=build /app/packages/refund-policy /app/packages/refund-policy
COPY --from=build /app/apps/services/workflow-workers/dist ./dist
COPY --from=build /app/apps/services/workflow-workers/package.json ./package.json
USER node
CMD ["node", "dist/server.js"]
