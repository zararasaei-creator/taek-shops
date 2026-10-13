# syntax=docker/dockerfile:1
#
# Taek Shops — production image (Phase 13). See docs/deployment.md.
#
# One image runs the web app AND the three existing jobs (emails:dispatch,
# images:cleanup-uploads, orders:expire-abandoned): it is `next start` plus the
# production node_modules, the app source the job scripts import, and the
# generated Prisma client. `output: "standalone"` is deliberately NOT used — its
# traced bundle does not include the job scripts' dependencies (tsx, the
# `src/` tree they import), and it would change `next start` behaviour for the
# e2e harness.
#
# Targets:
#   (default) runner   web app + jobs, non-root, NODE_ENV=production
#   migrate            `prisma migrate deploy` — a SEPARATE deploy step; the
#                      runner never migrates or seeds on startup
#
# Build-time inputs (public values baked into the bundle — see docs/deployment.md):
#   NEXT_PUBLIC_APP_URL, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, S3_PUBLIC_BASE_URL
# No secret is read at build time and none is stored in any layer.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
# openssl: Prisma's query engine. ca-certificates: TLS to Postgres/S3/Stripe/Resend.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ---- deps: full install (dev deps needed to build + for the prisma CLI) -------
FROM base AS deps
COPY package.json package-lock.json ./
# `postinstall` runs `prisma generate`, which needs the schema + config.
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci

# ---- build ---------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `public/` is currently empty, and git does not track empty directories, so a clean
# checkout (CI) has no such directory — create it so the runner stage can copy it.
RUN mkdir -p public
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
ARG S3_PUBLIC_BASE_URL
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL} \
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=${NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY} \
    S3_PUBLIC_BASE_URL=${S3_PUBLIC_BASE_URL}
# Env validation runs at module load, so the build needs a syntactically valid
# DATABASE_URL — a placeholder that points nowhere and is scoped to this RUN only
# (not persisted in the image). The build never connects to a database.
RUN DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build" npm run build

# ---- prod-deps: runtime node_modules only ---------------------------------------
FROM base AS prod-deps
COPY package.json package-lock.json ./
# --ignore-scripts: `postinstall` (prisma generate) needs the dev-only prisma CLI;
# the generated client is copied from `deps` in the runner stage instead.
RUN npm ci --omit=dev --ignore-scripts

# ---- migrate: explicit, separate deployment step ---------------------------------
FROM base AS migrate
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
USER node
# DATABASE_URL (or DIRECT_DATABASE_URL via the same variable) comes from the
# environment at run time. Never seeds.
ENTRYPOINT ["node", "node_modules/prisma/build/index.js"]
CMD ["migrate", "deploy"]

# ---- runner (default) --------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production \
    PORT=3000
RUN groupadd --system --gid 1001 app \
 && useradd --system --uid 1001 --gid app --home-dir /app --shell /usr/sbin/nologin app
COPY --from=prod-deps --chown=app:app /app/node_modules ./node_modules
# The generated Prisma client (query engine included) built against this OS.
COPY --from=deps --chown=app:app /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=app:app /app/.next ./.next
COPY --from=build --chown=app:app /app/public ./public
# Needed at run time: next.config.ts + package.json (next start), and for the jobs:
# src/ (imported by scripts), scripts/, tsconfig.json (tsx resolves the `@/` alias).
COPY --chown=app:app package.json next.config.ts tsconfig.json ./
COPY --chown=app:app src ./src
COPY --chown=app:app scripts ./scripts
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Binds all interfaces so the container port can be published; put a TLS-terminating
# reverse proxy in front (Next.js's own recommendation for self-hosting).
CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0"]
