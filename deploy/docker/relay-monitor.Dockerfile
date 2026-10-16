FROM node:22-bookworm-slim

WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --no-audit --no-fund \
    && npm cache clean --force

COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node src/db.ts ./src/db.ts
COPY --chown=node:node src/operator/outreach-monitor.ts ./src/operator/outreach-monitor.ts
COPY --chown=node:node src/operator/outreach-operations.ts ./src/operator/outreach-operations.ts
COPY --chown=node:node scripts/monitor-outreach.ts ./scripts/monitor-outreach.ts

ENV NODE_ENV=production

USER node

ENTRYPOINT ["./node_modules/.bin/tsx", "scripts/monitor-outreach.ts"]
