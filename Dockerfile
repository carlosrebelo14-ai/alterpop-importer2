FROM node:20-alpine
RUN apk add --no-cache openssl sqlite

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./
COPY prisma ./prisma/

RUN npm ci && npx prisma generate

COPY . .

RUN npm run build

# Garantir que a pasta /app/data existe para a montagem do volume SQLite
RUN mkdir -p /app/data

CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]
