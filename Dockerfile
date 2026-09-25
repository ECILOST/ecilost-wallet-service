FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY nest-cli.json tsconfig*.json ./
COPY src ./src

ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build
RUN npm ci --no-audit --no-fund && npm run prisma:generate && npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
RUN touch /app/.env && chown node:node /app/.env
USER node
EXPOSE 3002
CMD ["node", "dist/main.js"]
