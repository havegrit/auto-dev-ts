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

- [Claude Code](https://claude.ai/code) installed and authenticated (`claude` in PATH)
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
./run serve

# Scheduler only (daily worklog briefing)
./run daemon
```

## Spec workflow

`./run spec <file>` runs the full pipeline in order:

```
clarifier → planner → scaffold → test → review → cicd
```

The review step checks for a `[VERDICT: SHIP]` marker; if present, the pipeline exits early. Pass `--steps` to run a subset, `--iterations` to retry the scaffold→review loop.

## Dashboard

`./run serve` starts an HTTP server (default `http://127.0.0.1:8080`) with:

- Live agent status and daily run count
- Recent run history (agent, status, duration, output preview) — auto-refreshes every 10s
- Running jobs update live over SSE; click a row to expand a detail panel
- Submit form: agent picker + project name + model/effort settings

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
| `GET` | `/api/runs/:id/events` | SSE — live events for a running job |
| `GET` | `/api/stats` | Aggregate stats by agent and status |
| `GET`/`POST` | `/api/config` | Get/set model & effort + project list |
| `GET` | `/api/issues` · `POST /api/issues/:key/run` | Issue-tracker fetch + auto-process |

## Configuration

All configuration is via environment variables (copy `.env.example` to `.env`):

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTO_DEV_PROVIDER` | `anthropic` | LLM provider selection |
| `AUTO_DEV_MODEL` | (CLI default) | Claude model to use |
| `AUTO_DEV_EFFORT` | `high` | Effort level (`low`–`max`) |
| `AUTO_DEV_WORKSPACE_ROOT` | `./data/workspace` | Root for project-name resolution |
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
├── static/           Dashboard frontend (vanilla HTML/JS)
├── src/
│   ├── agents/       Agent implementations + registry
│   │   └── review/   Multi-lens review orchestrator + lens definitions
│   ├── workflows/    SpecWorkflow + issue-driven workflow
│   ├── llm/          LLM provider seam (registry + anthropic impl)
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
