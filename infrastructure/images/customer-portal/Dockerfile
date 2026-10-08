# Use only the reviewed context staged by verify-customer-portal-container.mjs.
# Packaging proof only: production deliberately disables local customer login.
FROM node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c AS node-runtime

FROM node-runtime AS build
RUN npm install --global pnpm@11.9.0
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/customer-portal/package.json ./apps/web/customer-portal/package.json
COPY packages/auth/package.json ./packages/auth/package.json
COPY packages/ui/package.json ./packages/ui/package.json
RUN pnpm --filter @cso/customer-portal... install --frozen-lockfile --ignore-scripts
COPY packages/auth/src ./packages/auth/src
COPY packages/ui/src ./packages/ui/src
COPY apps/web/customer-portal/app ./apps/web/customer-portal/app
COPY apps/web/customer-portal/components ./apps/web/customer-portal/components
COPY apps/web/customer-portal/lib ./apps/web/customer-portal/lib
COPY apps/web/customer-portal/tsconfig.json apps/web/customer-portal/next-env.d.ts ./apps/web/customer-portal/
COPY apps/web/customer-portal/next.config.ts ./apps/web/customer-portal/next.config.base.ts
COPY container-next.config.ts ./apps/web/customer-portal/next.config.ts
# No current public assets. Staging refuses an unreviewed public directory.
# Compile without network access: no service calls, telemetry, or remote fonts.
RUN --network=none pnpm --filter @cso/customer-portal build

FROM node-runtime AS runtime
WORKDIR /app/apps/web/customer-portal
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3100
COPY --from=build --chown=node:node /app/apps/web/customer-portal/.next/standalone /app
COPY --from=build --chown=node:node /app/apps/web/customer-portal/.next/static ./.next/static
USER node
CMD ["node", "server.js"]
