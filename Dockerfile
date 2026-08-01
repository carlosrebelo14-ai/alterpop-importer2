FROM node:20-alpine
RUN apk add --no-cache openssl sqlite

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV NODE_OPTIONS="--max-old-space-size=1024"
ENV OCIOSTOCK_CSV_URL="https://ociostock.gesio.be/dyndata/exportaciones/csvzip/catalog_1_50_54_2_40836fd3ce5ea622a4d34a8aa6c8cda3_csv_plain.csv"

COPY package.json package-lock.json* ./
COPY prisma ./prisma/

RUN npm ci && npx prisma generate

COPY . .

RUN npm run build

# Garantir que a pasta /app/data existe para a montagem do volume SQLite
RUN mkdir -p /app/data

CMD ["sh", "-c", "node scripts/setup/ensure-clean-db.js && npx prisma db push --skip-generate && npm run start"]
