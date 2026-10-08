# Use only the reviewed context staged by verify-admin-console-container.mjs.
# Packaging proof only: the admin UI is currently an unauthenticated placeholder.
FROM node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c AS node-runtime

FROM node-runtime AS build
RUN npm install --global pnpm@11.9.0
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/admin-console/package.json ./apps/web/admin-console/package.json
COPY packages/ui/package.json ./packages/ui/package.json
RUN pnpm --filter @cso/admin-console... install --frozen-lockfile --ignore-scripts
COPY packages/ui/src ./packages/ui/src
COPY apps/web/admin-console/app ./apps/web/admin-console/app
COPY apps/web/admin-console/tsconfig.json apps/web/admin-console/next-env.d.ts ./apps/web/admin-console/
COPY apps/web/admin-console/next.config.ts ./apps/web/admin-console/next.config.base.ts
COPY container-next.config.ts ./apps/web/admin-console/next.config.ts
# No current public assets. Staging refuses an unreviewed public directory.
# Compile without network access: no service calls, telemetry, or remote fonts.
RUN --network=none pnpm --filter @cso/admin-console build

FROM node-runtime AS runtime
WORKDIR /app/apps/web/admin-console
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3102
COPY --from=build --chown=node:node /app/apps/web/admin-console/.next/standalone /app
COPY --from=build --chown=node:node /app/apps/web/admin-console/.next/static ./.next/static
USER node
CMD ["node", "server.js"]
