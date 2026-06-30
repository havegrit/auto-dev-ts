# auto-dev

Development automation agent powered by [Claude Code SDK](https://github.com/anthropics/claude-agent-sdk-typescript). Orchestrates six specialized AI agents to automate scaffolding, code review, testing, CI/CD, planning, and spec clarification — without any LLM API key or per-token cost.

> [한국어 문서](README.ko.md)

## How it works

Instead of calling a cloud LLM API directly, auto-dev drives **Claude Code** (the CLI) programmatically via the Agent SDK. Each agent runs inside a Claude Code session with file I/O and shell access scoped to a workspace directory. The review agent fans out to four parallel sub-agents (correctness, security, performance, style) simultaneously.

All runs are persisted to a local SQLite database and visible through a built-in web dashboard.

## Agents

| Agent | Description |
|-------|-------------|
| `scaffold` | Generates code skeletons from a spec or description |
| `review` | Multi-lens code review: correctness · security · perf · style (parallel) |
| `test` | Generates test cases for existing code |
| `cicd` | Generates CI/CD pipeline configs (GitHub Actions, etc.) |
| `planner` | Produces a structured development plan from a spec |
| `clarifier` | Identifies ambiguities in a spec before planning |

## Requirements

- [Claude Code](https://claude.ai/code) installed and authenticated (`claude` in PATH), or Codex CLI installed and authenticated when using `AUTO_DEV_PROVIDER=codex-cli`
- Node.js ≥ 22
- npm

## Setup

```bash
git clone <repo>
cd auto-dev-ts
npm install
cp .env.example .env
```

Edit `.env` as needed (workspace root, port, daily run limit).

## Usage

Input can be an inline string or a file path — auto-dev detects automatically.

```bash
# Single agents
./run scaffold "Build a REST API for user authentication with JWT"
./run scaffold path/to/spec.md

./run review src/
./run test src/auth.ts
./run cicd "Node.js monorepo, deploy to AWS ECS"
./run planner path/to/spec.md
./run clarifier path/to/spec.md

# Full spec workflow  (clarifier → planner → scaffold → test → review → cicd)
./run spec path/to/spec.md

# Run specific steps only
./run spec path/to/spec.md --steps scaffold,test,review

# Status & stats
./run status

# HTTP API + dashboard
./run serve          # or: npm run serve:user  (see "Running as non-root")

# Scheduler only (daily worklog briefing)
./run daemon
```

### Running as non-root

The Claude Code SDK runs each agent with `--dangerously-skip-permissions`, which
Claude Code **refuses under root/sudo**. Running auto-dev as root makes every SDK
call fail with `Claude Code process exited with code 1` (model discovery, agent
runs, completions). Run it as a regular user instead.

For the server, `npm run serve:user` (→ `scripts/serve.sh`) auto-drops from root to
a non-root user (`AUTO_DEV_RUN_AS_USER`, default `shin`) before starting; that user
needs its own Claude credentials (`~/.claude/.credentials.json`). One-off workaround
for sandboxed containers: set `IS_SANDBOX=1`.

## Spec workflow

`./run spec <file>` runs the full pipeline in order:

```
clarifier → planner → scaffold → test → review → cicd
```

If `clarifier` determines the requirements are not ready, the pipeline stops before planning/implementation and returns concrete questions with recommendations. From the dashboard you can answer those questions inline and resume **without re-entering the spec** — the answers are merged with the original spec into a new linked run (this loops if the clarifier asks again). Each spec session also writes an accumulating plan document to `<project>/docs/plan/<slug>.md` (original spec + decision history + planner output). The review step checks for a `[VERDICT: SHIP]` marker; if present, the pipeline exits early. Pass `--steps` to run a subset, `--iterations` to retry the scaffold→review loop.

## Dashboard

`./run serve` starts an HTTP server (default `http://127.0.0.1:8080`) with:

- Live agent status and daily run count
- Recent run history (agent, status, duration, output preview) — auto-refreshes every 10s
- Running jobs update live over SSE; click a row to expand a detail panel
- Agent output is rendered as Markdown (sanitized) with a render/raw toggle
- When a spec run stops on clarifier questions, the detail panel shows answer fields (pre-filled with recommendations) to resume in place
- Submit form: agent picker + project dropdown (workspace projects) + model/effort settings

If accessing from a remote machine over SSH, use local port forwarding:

```bash
ssh -L 8080:127.0.0.1:8080 user@host -N
```

## REST API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/status` | Agent list + run guard + circuit breaker stats |
| `POST` | `/api/agents/:name` | Invoke a single agent (accepts `project`) |
| `POST` | `/api/clarify` | Run clarifier with Q&A context |
| `POST` | `/api/specs` | Run spec workflow |
| `POST` | `/api/llm/complete` | One-shot LLM completion proxy (external apps via subscription) |
| `GET` | `/api/runs` | Recent runs (`?limit=`) |
| `GET` | `/api/runs/:id` | Single run detail |
| `GET` | `/api/runs/:id/clarification` | Pending clarifier questions for a stopped spec run |
| `POST` | `/api/runs/:id/answers` | Resume a clarified spec run with `{ answers }` (no spec re-entry) |
| `GET` | `/api/runs/:id/events` | SSE — live events for a running job |
| `GET` | `/api/stats` | Aggregate stats by agent and status |
| `GET`/`POST` | `/api/config` | Get/set model, fallback, per-agent models & effort + project list |
| `GET` | `/api/issues` · `POST /api/issues/:key/run` | Issue-tracker fetch + auto-process |

## Configuration

Configuration can be changed from the dashboard settings panel. Runtime changes are saved to `AUTO_DEV_CONFIG_PATH` (default `./data/config.json`) and take precedence over environment variables. Environment variables are still supported for bootstrapping:

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTO_DEV_PROVIDER` | `anthropic` | LLM provider selection (`anthropic` or `codex-cli`) |
| `AUTO_DEV_MODEL` | (provider default) | Provider model to use |
| `AUTO_DEV_AGENT_<AGENT>_MODEL` | unset | Per-agent model override, e.g. `AUTO_DEV_AGENT_SCAFFOLD_MODEL` |
| `AUTO_DEV_FALLBACK_MODEL` | unset | Model to use when the selected global or per-agent model is unavailable |
| `AUTO_DEV_EFFORT` | `high` | Effort level (`low`–`max`; Codex currently exposes `low`/`medium`/`high`) |
| `AUTO_DEV_CONFIG_PATH` | `./data/config.json` | Dashboard-persisted runtime config file |
| `AUTO_DEV_CODEX_COMMAND` | `codex` | Codex CLI command when `AUTO_DEV_PROVIDER=codex-cli` |
| `AUTO_DEV_CODEX_TIMEOUT_MS` | `600000` | Codex CLI execution timeout |
| `AUTO_DEV_WORKSPACE_ROOT` | `./data/workspace` | Root for project-name resolution |
| `AUTO_DEV_RUN_AS_USER` | `shin` | Non-root user `scripts/serve.sh` drops to when started as root |
| `AUTO_DEV_DB_PATH` | `./data/auto-dev.db` | SQLite database path |
| `AUTO_DEV_BIND_ADDR` | `127.0.0.1` | HTTP server bind address |
| `AUTO_DEV_BIND_PORT` | `8080` | HTTP server port |
| `AUTO_DEV_DAILY_RUN_LIMIT` | `100` | Max agent runs per day (empty = unlimited) |
| `AUTO_DEV_ISSUE_TRACKER_URL` | (none) | Issue-tracker URL — enables integration when set |
| `AUTO_DEV_WORKLOG_BRIEFING_ENABLED` | `false` | Enable daily review briefing cron |
| `AUTO_DEV_WORKLOG_BRIEFING_CRON` | `0 9 * * *` | Cron expression for briefing schedule |

## Project structure

```
auto-dev-ts/
├── prompts/          System prompts for each agent (Markdown)
├── scripts/          Ops scripts (serve.sh — non-root server launcher)
├── static/           Dashboard frontend (vanilla HTML/JS)
├── src/
│   ├── agents/       Agent implementations + registry
│   │   └── review/   Multi-lens review orchestrator + lens definitions
│   ├── workflows/    SpecWorkflow + issue-driven workflow
│   ├── llm/          LLM provider seam (registry + anthropic/codex impls)
│   ├── integrations/ issue-tracker client
│   ├── store/        SQLite schema + CRUD
│   ├── lib/          Runner, guards, circuit breaker, SSE, workspace resolver
│   ├── server/       Hono HTTP server + routes
│   ├── schedule/     node-cron daily briefing
│   └── cli.ts        Commander CLI entry point
├── .env.example
├── package.json
└── tsconfig.json
```

## License

MIT
