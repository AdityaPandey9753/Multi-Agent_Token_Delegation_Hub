# OpenClaw Gateway - Next.js 14 (App Router)
# Multi-stage build: install deps, build, run.

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001
ENV HOSTNAME=0.0.0.0
COPY --from=build /app ./
EXPOSE 3001
CMD ["npx", "next", "start", "-p", "3001", "-H", "0.0.0.0"]
