# The app image for deploy/local/docker-compose.yml. Build context is the repo root; what it may
# copy is limited by app.Dockerfile.dockerignore (no node_modules, .next, or .env* files).
FROM node:22.23.3-bookworm-slim

# Chromium renders the PDF routes (lib/lp-report-pdf.ts reads CHROME_EXECUTABLE_PATH); the fonts
# give it something to fall back on. curl is for the healthcheck.
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-color-emoji ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# `npm run bootstrap` runs scripts/bootstrap-fund.ts through `npx tsx`; installed here so it needs
# no download at run time.
RUN npm install -g tsx@4.23.15

COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci --no-audit --no-fund

COPY . .

# NEXT_PUBLIC_* are compiled into the bundle, so they are build arguments. Changing one means
# rebuilding this image (docker compose build app).
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_TERMS_URL
ARG NEXT_PUBLIC_PRIVACY_URL
ARG NEXT_PUBLIC_DISABLE_SW
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_TERMS_URL=$NEXT_PUBLIC_TERMS_URL \
    NEXT_PUBLIC_PRIVACY_URL=$NEXT_PUBLIC_PRIVACY_URL \
    NEXT_PUBLIC_DISABLE_SW=$NEXT_PUBLIC_DISABLE_SW \
    NEXT_TELEMETRY_DISABLED=1

RUN npm run build

ENV NODE_ENV=production \
    CHROME_EXECUTABLE_PATH=/usr/bin/chromium
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000"]
