FROM node:24-bookworm-slim AS base

ARG CLAUDE_CODE_VERSION=2.1.274

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    build-essential \
    python3 \
  && rm -rf /var/lib/apt/lists/* \
  && groupmod --new-name app node \
  && usermod --login app --home /home/app --move-home node \
  && npm install --global "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && mkdir -p /app /home/app/.claude /home/app/.codex \
  && chown -R app:app /app /home/app

WORKDIR /app

FROM base AS deps
COPY package*.json ./
RUN npm ci

FROM deps AS dev
COPY --chown=app:app . .
USER app
ENV HOME=/home/app \
    XDG_CONFIG_HOME=/home/app/.config \
    CODEX_HOME=/home/app/.codex \
    NODE_ENV=development
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl --fail --silent http://127.0.0.1:8080/healthz || exit 1
CMD ["npm", "run", "serve"]

FROM deps AS build
COPY --chown=app:app . .
RUN npm run build && npm prune --omit=dev

FROM base AS prod
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/static ./static
COPY --from=build --chown=app:app /app/prompts ./prompts
COPY --from=build --chown=app:app /app/integrations ./integrations
COPY --from=build --chown=app:app /app/scripts ./scripts
COPY --from=build --chown=app:app /app/package.json ./package.json
USER app
ENV HOME=/home/app \
    XDG_CONFIG_HOME=/home/app/.config \
    CODEX_HOME=/home/app/.codex \
    NODE_ENV=production
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl --fail --silent http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "dist/cli.js", "serve"]
