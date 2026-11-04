# 内部账目管理平台：前端静态文件 + 后端 API 打包为一个镜像（数据库为单独的 postgres 容器，见 docker-compose.yml）
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY shared shared
COPY server server
COPY web web
RUN npm -w web run build && npm -w server run build

FROM node:22-alpine
# pg_dump 用于每日自动备份；tzdata 保证业务日期按北京时间
RUN apk add --no-cache postgresql16-client tzdata
ENV NODE_ENV=production TZ=Asia/Shanghai PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --no-audit --no-fund -w server && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
COPY db/migrations db/migrations
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "--enable-source-maps", "server/dist/index.js"]
