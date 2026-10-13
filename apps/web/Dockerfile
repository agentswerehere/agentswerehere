# Build from the repo root: docker build -f apps/web/Dockerfile .
# API_INTERNAL_URL and PUBLIC_BASE_URL are read when the server starts.
# Cloud Run sets PORT. Do not pin it here.
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY config ./config
COPY apps ./apps
COPY infra/billing-kill-switch ./infra/billing-kill-switch
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @agentswerehere/web build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
EXPOSE 8080
CMD ["node", "apps/web/server.js"]
