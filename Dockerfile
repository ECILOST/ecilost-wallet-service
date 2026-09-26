FROM node:22-bookworm-slim AS build
# Prisma 6 usa un motor nativo que enlaza libssl. La imagen slim no trae openssl, asi que
# Prisma no detecta la version, elige el motor openssl-1.1.x y falla en la primera consulta.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY nest-cli.json tsconfig*.json ./
COPY src ./src

ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build
RUN npm ci --no-audit --no-fund && npm run prisma:generate && npm run build

FROM node:22-bookworm-slim AS runtime
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
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
