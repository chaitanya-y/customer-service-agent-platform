# Use only the reviewed context staged by verify-operations-console-container.mjs.
# Packaging proof only: production deliberately disables local staff login.
FROM node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c AS node-runtime

FROM node-runtime AS build
RUN npm install --global pnpm@11.9.0
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/operations-console/package.json ./apps/web/operations-console/package.json
COPY packages/ui/package.json ./packages/ui/package.json
RUN pnpm --filter @cso/operations-console... install --frozen-lockfile --ignore-scripts
COPY packages/ui/src ./packages/ui/src
COPY apps/web/operations-console/app ./apps/web/operations-console/app
COPY apps/web/operations-console/components ./apps/web/operations-console/components
COPY apps/web/operations-console/lib ./apps/web/operations-console/lib
COPY apps/web/operations-console/tsconfig.json apps/web/operations-console/next-env.d.ts ./apps/web/operations-console/
COPY apps/web/operations-console/next.config.ts ./apps/web/operations-console/next.config.base.ts
COPY container-next.config.ts ./apps/web/operations-console/next.config.ts
# No current public assets. Staging refuses an unreviewed public directory.
# Compile without network access: no service calls, telemetry, or remote fonts.
RUN --network=none pnpm --filter @cso/operations-console build

FROM node-runtime AS runtime
WORKDIR /app/apps/web/operations-console
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3101
COPY --from=build --chown=node:node /app/apps/web/operations-console/.next/standalone /app
COPY --from=build --chown=node:node /app/apps/web/operations-console/.next/static ./.next/static
USER node
CMD ["node", "server.js"]
