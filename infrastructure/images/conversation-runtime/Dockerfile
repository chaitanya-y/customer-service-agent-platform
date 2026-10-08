# Build via tools/local/verify-conversation-container.mjs --run. It stages only
# reviewed inputs; this is a local packaging proof, not a deployment recipe.
FROM node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c AS node-runtime

FROM node-runtime AS package-manager
RUN npm install --global pnpm@11.9.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/services/conversation-runtime/package.json ./apps/services/conversation-runtime/package.json
COPY packages/observability-node/package.json ./packages/observability-node/package.json

FROM package-manager AS build
RUN pnpm --filter @customer-service-os/conversation-runtime... install --frozen-lockfile --ignore-scripts
COPY apps/services/conversation-runtime/tsconfig.json ./apps/services/conversation-runtime/tsconfig.json
COPY apps/services/conversation-runtime/src ./apps/services/conversation-runtime/src
COPY packages/observability-node/index.mjs packages/observability-node/index.d.mts ./packages/observability-node/
RUN pnpm --filter @customer-service-os/conversation-runtime build
RUN find apps/services/conversation-runtime/dist -name '*.map' -delete

FROM package-manager AS production-dependencies
RUN pnpm --filter @customer-service-os/conversation-runtime... install --prod --frozen-lockfile --ignore-scripts

FROM node-runtime AS runtime
WORKDIR /app/apps/services/conversation-runtime
COPY --from=production-dependencies /app/node_modules /app/node_modules
COPY --from=production-dependencies /app/apps/services/conversation-runtime/node_modules ./node_modules
COPY --from=production-dependencies /app/packages/observability-node/node_modules /app/packages/observability-node/node_modules
COPY --from=production-dependencies /app/packages/observability-node/package.json /app/packages/observability-node/package.json
COPY --from=build /app/packages/observability-node/index.mjs /app/packages/observability-node/index.mjs
COPY --from=build /app/apps/services/conversation-runtime/dist ./dist
COPY --from=build /app/apps/services/conversation-runtime/package.json ./package.json
ENV HOST=0.0.0.0
USER node
CMD ["node", "dist/bootstrap.js"]
