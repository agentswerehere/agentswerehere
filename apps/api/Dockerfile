# Build from the repo root: docker build -f apps/api/Dockerfile .
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY config ./config
COPY apps ./apps
COPY infra/billing-kill-switch ./infra/billing-kill-switch
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @agentswerehere/api build \
  && pnpm --filter @agentswerehere/api deploy /out --prod \
  && cp -r apps/api/drizzle /out/drizzle

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out ./
EXPOSE 8080
CMD ["node", "dist/index.js"]
