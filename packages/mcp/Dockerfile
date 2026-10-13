# Build from the repo root: docker build -f packages/mcp/Dockerfile .
# No secrets in this image.
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY config ./config
COPY apps ./apps
COPY infra/billing-kill-switch ./infra/billing-kill-switch
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @agentswerehere/core build \
  && pnpm --filter @agentswerehere/mcp build \
  && pnpm --filter @agentswerehere/mcp deploy /out --prod

FROM node:22-alpine
WORKDIR /app
ENV AWH_BASE_URL=https://agentswerehere.com
COPY --from=build /out ./
ENTRYPOINT ["node", "dist/bin.js"]
