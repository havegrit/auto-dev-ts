# auto-dev Docker Containerization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Containerize the `auto-dev` CLI/dashboard for development use, with a dev-first compose setup that runs the dashboard and supports `exec`-based CLI agent runs.

**Architecture:** A multi-stage `Dockerfile` (`base`→`deps`→`dev`, and `build`→`prod`) on `node:24-bookworm-slim`. The dev service bind-mounts the source for `tsx`-based reload, keeps `node_modules` in a named volume so the container-compiled `better-sqlite3` survives the bind mount, and authenticates Claude via a container-private `claude-config` named volume seeded once from the host.

**Tech Stack:** Docker, Docker Compose v2, Node.js 24, TypeScript/`tsx`, `@anthropic-ai/claude-code` CLI (pinned 2.1.183), `better-sqlite3` (native).

## Global Constraints

- Base image: `node:24-bookworm-slim` (Node ≥ 24, per package.json `engines`).
- Claude CLI pinned to `@anthropic-ai/claude-code@2.1.183` (match host, reproducible).
- Container must bind the HTTP server to `0.0.0.0`; host exposure is loopback-only (`127.0.0.1:8080:8080`).
- Claude credentials live in a container-private `claude-config` named volume mounted `rw` at `/root/.claude`; never bind-mount the host `~/.claude` directory.
- `node_modules` must be a named volume (`auto-dev-node_modules`) so the bind mount never shadows the container-compiled native modules.
- Commit style (jay): `prefix: title`, lowercase imperative, no trailing period, **no `Co-Authored-By` trailer**.
- All paths below are relative to repo root `/root/workspace/auto-dev-ts`.

---

### Task 1: Build context exclusions (`.dockerignore`)

**Files:**
- Create: `.dockerignore`

**Interfaces:**
- Consumes: nothing.
- Produces: a slim build context so `COPY` in later stages does not pull host `node_modules`/`dist`/`data`/secrets.

- [ ] **Step 1: Create `.dockerignore`**

```
node_modules
dist
data
.git
.env
*.tsbuildinfo
docs/superpowers
```

- [ ] **Step 2: Verify it parses and excludes the heavy dirs**

Run: `docker build --no-cache -f Dockerfile -t _ignorecheck . 2>&1 | head -5 || true`
(This will fail because `Dockerfile` doesn't exist yet — that's expected at this point.)
Instead verify the file is well-formed:
Run: `cat .dockerignore && echo "---" && test -f .dockerignore && echo OK`
Expected: prints the 7 lines then `OK`.

- [ ] **Step 3: Commit**

```bash
git add .dockerignore
git commit -m "build: add dockerignore for image build context"
```

---

### Task 2: Multi-stage `Dockerfile`

**Files:**
- Create: `Dockerfile`

**Interfaces:**
- Consumes: `.dockerignore` (Task 1), `package.json` + `package-lock.json` (existing), `src/` (existing).
- Produces: image targets `dev` (CMD `npm run serve`) and `prod` (CMD `node dist/cli.js serve`). Both have `claude` 2.1.183 on PATH, `git`, and a build toolchain in earlier stages. The `dev` target expects source to be bind-mounted at `/app` at runtime and `node_modules` provided by a named volume.

- [ ] **Step 1: Write `Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1

# --- base: runtime + Claude CLI + toolchain for native modules ---
FROM node:24-bookworm-slim AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git build-essential python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Claude CLI is spawned by @anthropic-ai/claude-agent-sdk; pin to host version.
RUN npm install -g @anthropic-ai/claude-code@2.1.183
WORKDIR /app

# --- deps: install node deps, compiling better-sqlite3 for container arch ---
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm install

# --- dev: source is bind-mounted at runtime; node_modules via named volume ---
FROM deps AS dev
ENV NODE_ENV=development
EXPOSE 8080
CMD ["npm", "run", "serve"]

# --- build: compile TypeScript to dist/ ---
FROM deps AS build
COPY . .
RUN npm run build

# --- prod: runtime-only deps + compiled dist/ ---
FROM base AS prod
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY run ./run
COPY static ./static
COPY prompts ./prompts
EXPOSE 8080
CMD ["node", "dist/cli.js", "serve"]
```

- [ ] **Step 2: Build the dev target**

Run: `docker build --target dev -t auto-dev:dev .`
Expected: build succeeds; final line `naming to docker.io/library/auto-dev:dev` (or `writing image ...`).

- [ ] **Step 3: Verify pinned tool versions inside the dev image**

Run: `docker run --rm auto-dev:dev sh -c 'node --version && claude --version && git --version'`
Expected: `v24.*`, `2.1.183 (Claude Code)`, and a `git version ...` line.

- [ ] **Step 4: Verify better-sqlite3 loads (compiled for container arch)**

Run: `docker run --rm auto-dev:dev node -e "const D=require('better-sqlite3'); const db=new D(':memory:'); db.exec('create table t(x)'); console.log('sqlite ok');"`
Expected: prints `sqlite ok` with no native-module ABI error.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile
git commit -m "build: add multi-stage dockerfile for dev and prod"
```

---

### Task 3: Compose stack (`compose.yaml`)

**Files:**
- Create: `compose.yaml`

**Interfaces:**
- Consumes: `Dockerfile` targets `dev`/`prod` (Task 2), `.env` (existing; user-provided runtime config).
- Produces: service `auto-dev` (dev, default) and `auto-dev-prod` (profile `prod`); named volumes `auto-dev-node_modules` and `claude-config` referenced by the seed script (Task 4) and verification (Task 5).

- [ ] **Step 1: Write `compose.yaml`**

```yaml
services:
  auto-dev:
    build:
      context: .
      target: dev
    env_file: .env
    environment:
      AUTO_DEV_BIND_ADDR: 0.0.0.0
      AUTO_DEV_BIND_PORT: 8080
    ports:
      - "127.0.0.1:8080:8080"
    volumes:
      - ./:/app
      - auto-dev-node_modules:/app/node_modules
      - claude-config:/root/.claude
    command: npm run serve

  auto-dev-prod:
    profiles: [prod]
    build:
      context: .
      target: prod
    env_file: .env
    environment:
      AUTO_DEV_BIND_ADDR: 0.0.0.0
      AUTO_DEV_BIND_PORT: 8080
    ports:
      - "127.0.0.1:8080:8080"
    volumes:
      - ./data:/app/data
      - claude-config:/root/.claude
    command: node dist/cli.js serve

volumes:
  auto-dev-node_modules:
  claude-config:
```

- [ ] **Step 2: Ensure a `.env` exists for `env_file`**

Run: `test -f .env && echo "has .env" || cp .env.example .env`
Expected: prints `has .env`, or silently creates `.env` from the example.

- [ ] **Step 3: Validate the compose file**

Run: `docker compose config >/dev/null && echo "compose valid"`
Expected: prints `compose valid` (no YAML/schema errors; both services and both volumes resolve).

- [ ] **Step 4: Confirm the dev service is the default (prod is gated)**

Run: `docker compose config --services`
Expected: lists `auto-dev` only (prod is hidden behind the `prod` profile).

- [ ] **Step 5: Commit**

```bash
git add compose.yaml
git commit -m "build: add compose stack with dev service and prod profile"
```

---

### Task 4: Claude credential seed script (`docker/seed-claude.sh`)

**Files:**
- Create: `docker/seed-claude.sh`

**Interfaces:**
- Consumes: host `~/.claude/.credentials.json` (+ optional `settings.json`), the `claude-config` named volume declared in `compose.yaml` (Task 3).
- Produces: a populated `claude-config` volume at `/root/.claude` so the dev container authenticates Claude without bind-mounting the host config dir.

- [ ] **Step 1: Write `docker/seed-claude.sh`**

```bash
#!/usr/bin/env bash
# Seed the container-private `claude-config` volume from the host's Claude
# credentials. Run once after `docker compose build`. Idempotent.
set -euo pipefail

SRC="${HOME}/.claude"
PROJECT="$(basename "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)")"
VOLUME="${PROJECT}_claude-config"

if [[ ! -f "${SRC}/.credentials.json" ]]; then
  echo "ERROR: ${SRC}/.credentials.json not found. Authenticate the host first: claude" >&2
  exit 1
fi

# Ensure the named volume exists (created lazily by compose otherwise).
docker volume inspect "${VOLUME}" >/dev/null 2>&1 || docker volume create "${VOLUME}" >/dev/null

# Copy credentials (+ settings if present) into the volume via a throwaway container.
docker run --rm \
  -v "${VOLUME}:/dest" \
  -v "${SRC}:/src:ro" \
  busybox:latest sh -c '
    mkdir -p /dest
    cp /src/.credentials.json /dest/.credentials.json
    [ -f /src/settings.json ] && cp /src/settings.json /dest/settings.json || true
    chmod 600 /dest/.credentials.json
    echo "seeded:"; ls -la /dest
  '
echo "Done. claude-config volume seeded from ${SRC}."
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x docker/seed-claude.sh`
Expected: no output; `test -x docker/seed-claude.sh && echo OK` prints `OK`.

- [ ] **Step 3: Lint the script syntax**

Run: `bash -n docker/seed-claude.sh && echo "syntax ok"`
Expected: prints `syntax ok`.

- [ ] **Step 4: Run the seed (requires the dev image/volume from Task 3)**

Run: `bash docker/seed-claude.sh`
Expected: prints `seeded:` followed by a listing containing `.credentials.json`, then `Done. ...`. If the host has no credentials it exits with the guidance message — authenticate with `claude` on the host first, then re-run.

- [ ] **Step 5: Verify the volume actually holds the credential**

Run: `docker run --rm -v auto-dev-ts_claude-config:/c busybox:latest sh -c 'test -f /c/.credentials.json && echo "cred present"'`
Expected: prints `cred present`. (Adjust the volume name to the `docker compose config --volumes` output if the project dir differs.)

- [ ] **Step 6: Commit**

```bash
git add docker/seed-claude.sh
git commit -m "build: add claude credential seed script for container volume"
```

---

### Task 5: End-to-end verification

**Files:**
- Modify: none (verification only).

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: confirmation that the design's acceptance criteria pass.

- [ ] **Step 1: Bring up the dev service**

Run: `docker compose up -d --build`
Expected: `auto-dev` container reaches state `Up`. Confirm: `docker compose ps` shows `auto-dev` running with `127.0.0.1:8080->8080/tcp`.

- [ ] **Step 2: Dashboard responds**

Run: `sleep 3; curl -fsS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/`
Expected: a `200` (or other success/redirect code the dashboard returns — a non-`000`, non-`5xx` response means the server is up).

- [ ] **Step 3: Tool versions inside the running container**

Run: `docker compose exec auto-dev sh -c 'node --version && claude --version'`
Expected: `v24.*` and `2.1.183 (Claude Code)`.

- [ ] **Step 4: Claude auth works end-to-end via an agent run**

Run: `docker compose exec auto-dev ./run clarifier "Build a URL shortener with click analytics"`
Expected: the clarifier agent runs and returns clarifying questions/output — i.e. it authenticated against Claude (no "not authenticated"/login error). If it fails on auth, re-run Task 4 seeding.

- [ ] **Step 5: SQLite write path works (native module + persistence)**

Run: `docker compose exec auto-dev ./run status`
Then: `test -f data/auto-dev.db && echo "db present on host"`
Expected: `status` prints run history without a `better-sqlite3` ABI error, and the DB file is visible on the host (bind mount persistence).

- [ ] **Step 6: Tear down**

Run: `docker compose down`
Expected: `auto-dev` removed; named volumes `auto-dev-node_modules` and `claude-config` persist (`docker volume ls | grep auto-dev`).

- [ ] **Step 7: No commit (verification task).** If any docs were updated as a result, commit them under Task 6.

---

### Task 6: Document Docker usage in README

**Files:**
- Modify: `README.md` (add a "Docker" section), `README.ko.md` (Korean mirror)

**Interfaces:**
- Consumes: the finished compose workflow (Tasks 3–5).
- Produces: user-facing run instructions.

- [ ] **Step 1: Add a Docker section to `README.md`**

Insert after the existing "Setup" section:

```markdown
## Docker

Dev-first containerized setup (source bind-mounted, `tsx` reload).

```bash
# 1. Build the image
docker compose build

# 2. Seed Claude credentials into the container-private volume (once)
#    Requires the host to be authenticated first: `claude`
bash docker/seed-claude.sh

# 3. Start the dashboard (http://127.0.0.1:8080)
docker compose up -d

# 4. Run agents via exec
docker compose exec auto-dev ./run scaffold "Build a REST API with JWT auth"
docker compose exec auto-dev ./run review src/

# Logs / stop
docker compose logs -f auto-dev
docker compose down
```

Notes:
- Claude is authenticated via a container-private `claude-config` volume (seeded
  once from the host); the container refreshes its own OAuth token.
- The `claude` CLI is pinned to `2.1.183` in the image.
- A `prod` image target exists: `docker compose --profile prod up auto-dev-prod`.
```

- [ ] **Step 2: Mirror the section in `README.ko.md`**

Add the equivalent Korean section after its Setup section (same commands, Korean prose for the notes).

- [ ] **Step 3: Verify the docs render and commands match files**

Run: `grep -q "docker compose" README.md && grep -q "seed-claude.sh" README.md && echo "readme ok"`
Expected: prints `readme ok`.

- [ ] **Step 4: Commit**

```bash
git add README.md README.ko.md
git commit -m "docs: document docker dev workflow in readme"
```

---

## Self-Review

**Spec coverage:**
- Multi-stage Dockerfile (base→deps→dev / build→prod) → Task 2. ✓
- claude CLI pinned 2.1.183 on PATH → Task 2 (base stage), verified Task 2/5. ✓
- better-sqlite3 native build → Task 2 (build-essential/python3), verified Task 2 Step 4. ✓
- compose dev service, 0.0.0.0 bind, loopback port, named volumes → Task 3. ✓
- prod profile defined but gated → Task 3 Steps 1/4. ✓
- node_modules named volume rationale → Task 3 (volume), Global Constraints. ✓
- claude-config container-private volume + rw + seed once → Task 4. ✓
- .dockerignore → Task 1. ✓
- Acceptance criteria 1–6 from spec → Task 5 Steps 1–6. ✓
- README docker section → Task 6. ✓

**Placeholder scan:** No TBD/TODO; every step has concrete file content or an exact command + expected output. ✓

**Type/name consistency:** Volume names `auto-dev-node_modules` and `claude-config` are consistent across Tasks 3, 4, 5. Compose-prefixed volume name (`auto-dev-ts_claude-config` / `<project>_claude-config`) is noted in Task 4 Step 1 and Step 5 to match Docker's default naming. Image targets `dev`/`prod` consistent across Tasks 2–3. ✓

**Note on verification env:** Tasks 2–5 require the Docker daemon and (for Step 4 of Tasks 4/5) valid host Claude credentials. The daemon is confirmed available on this host; credential seeding is the one human-gated step.
