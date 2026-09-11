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

# Decisão 13 (2026-09-11, incidente da Tarefa 27) — "prisma db push" SAIU daqui de
# propósito. Corria a cada boot, incluindo em cada tentativa de um crash-loop: um
# DROP COLUMN com dados recusado por falta de --accept-data-loss reiniciou a máquina
# 10x seguidas até ao limite de restarts e pôs a app em baixo ~20 min, sem ninguém ver
# o aviso de perda de dados a tempo de decidir.
#
# Schema changes passam a ser um PASSO DE DEPLOY deliberado e manual, depois do
# `fly deploy`, nunca escondido dentro do boot do container:
#   fly ssh console -a alterpop-importer-app -C "sh -lc 'cd /app && npm run db:push'"
# Lê SEMPRE o aviso de "data loss" antes de decidir se um --accept-data-loss é mesmo
# a decisão certa — nunca acrescentar às cegas para calar o erro.
CMD ["sh", "-c", "node scripts/setup/ensure-clean-db.js && npm run start"]
