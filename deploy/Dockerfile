# ── 构建阶段 ──────────────────────────────────────────────
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@12.18.0 --activate

WORKDIR /app

# 先拷依赖清单，利用镜像层缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/fitkit/package.json      packages/fitkit/
COPY packages/core/package.json        packages/core/
COPY packages/adapters/otm/package.json       packages/adapters/otm/
COPY packages/adapters/mywhoosh/package.json  packages/adapters/mywhoosh/
COPY apps/server/package.json          apps/server/

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm build

# ── 运行阶段 ──────────────────────────────────────────────
FROM node:22-alpine AS runtime

RUN apk add --no-cache tini

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules      ./node_modules
COPY --from=builder /app/package.json      ./package.json
COPY --from=builder /app/packages/fitkit/package.json      ./packages/fitkit/
COPY --from=builder /app/packages/core/package.json        ./packages/core/
COPY --from=builder /app/packages/adapters/otm/package.json       ./packages/adapters/otm/
COPY --from=builder /app/packages/adapters/mywhoosh/package.json  ./packages/adapters/mywhoosh/
COPY --from=builder /app/apps/server/package.json          ./apps/server/

COPY --from=builder /app/packages/fitkit/dist      ./packages/fitkit/dist
COPY --from=builder /app/packages/core/dist        ./packages/core/dist
COPY --from=builder /app/packages/adapters/otm/dist       ./packages/adapters/otm/dist
COPY --from=builder /app/packages/adapters/mywhoosh/dist  ./packages/adapters/mywhoosh/dist
COPY --from=builder /app/apps/server/dist          ./apps/server/dist
COPY --from=builder /app/apps/server/migrations    ./apps/server/migrations

EXPOSE 8080
USER node

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/server/dist/index.js"]
