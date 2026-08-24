# auto-dev

Development automation agent powered by [Claude Code SDK](https://github.com/anthropics/claude-agent-sdk-typescript). Orchestrates six specialized AI agents to automate scaffolding, code review, testing, CI/CD, planning, and spec clarification — without any LLM API key or per-token cost.

> [한국어 문서](README.ko.md)

## How it works

Instead of calling a cloud LLM API directly, auto-dev drives **Claude Code** (the CLI) programmatically via the Agent SDK. Each agent runs inside a Claude Code session with file I/O and shell access scoped to a workspace directory. The review agent fans out to four parallel sub-agents (correctness, security, performance, style) simultaneously.

When the planner emits a `TEAM_PLAN` dependency DAG, independent tasks run in parallel.
Write tasks use isolated git worktrees and are integrated automatically; conflicts are
handed to the internal integrator agent. Legacy `PLAN` output falls back to the sequential
workflow, and nested teams are limited to two levels.

All runs are persisted to a local SQLite database and visible through a built-in web dashboard.

## Agents

| Agent | Description |
|-------|-------------|
| `scaffold` | Generates code skeletons from a spec or description |
| `review` | Multi-lens code review: correctness · security · perf · style (parallel) |
| `test` | Generates test cases for existing code |
| `cicd` | Generates CI-first pipeline configs; CD is opt-in |
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
./run cicd --cd "Node.js monorepo, deploy to AWS ECS"
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

# Install/start a user service independent of the SSH session
npm run service:install
npm run service:start
npm run service:status

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

### Keeping the server alive after SSH exits

Running `./run serve` in an SSH foreground terminal can terminate the server and its
active specs when that terminal closes. `npm run service:install` writes and enables
`~/.config/systemd/user/auto-dev.service` using the current project's absolute path.
Start it with `npm run service:start`; the server and provider child processes then run
outside the SSH session and restart after an unexpected process failure.

The user service requires linger to survive logout. The installer checks it and, when
disabled, prints the required `sudo loginctl enable-linger <user>` command. Read logs
with `npm run service:logs`. Do not run `./run serve` and the service on the same port.

Dashboard specs already run in the service background, independently of the HTTP
response, so closing the browser or SSH port-forward does not cancel them. Durable
queue/checkpoint recovery across a host reboot or service restart is not implemented;
an in-flight run is recorded as a `server_restart` failure in that case.

### OpenClaw + Telegram

An existing OpenClaw Telegram account can act as the inbound gateway. No public domain,
webhook, or additional auto-dev poller is required. OpenClaw receives Telegram messages,
and the `integrations/openclaw/skills/auto-dev-spec` skill starts a background spec through
the loopback API. auto-dev sends completion, failure, cancellation, and clarification
notifications directly through the selected OpenClaw account.

```bash
# .env
AUTO_DEV_OPENCLAW_ENABLED=true
AUTO_DEV_OPENCLAW_ACCOUNT=main
AUTO_DEV_OPENCLAW_COMMAND=/home/user/.local/bin/openclaw
AUTO_DEV_OPENCLAW_CONFIG_PATH=/home/user/.openclaw/openclaw.json

# Let OpenClaw load the repository skill root, then restart its gateway
openclaw config set skills.load.extraDirs \
  '["/absolute/path/auto-dev-ts/integrations/openclaw/skills"]' --strict-json
```

In Telegram, request an auto-dev run naturally or use
`/auto_dev_spec <request>` / `/skill auto-dev-spec <request>`. Include a run ID to request
status or cancellation. Integration endpoints are accepted only while
`AUTO_DEV_BIND_ADDR=127.0.0.1`; optionally set the same
`AUTO_DEV_OPENCLAW_API_TOKEN` in the auto-dev and OpenClaw execution environments.

## Spec workflow

`./run spec <file>` runs the full pipeline in order:

```
clarifier → planner → scaffold → test → review → cicd
```

If `clarifier` determines the requirements are not ready, the pipeline stops before planning/implementation and returns concrete questions with recommendations. From the dashboard you can answer those questions inline and resume **without re-entering the spec** — the answers are merged with the original spec into a new linked run (this loops if the clarifier asks again). Each spec session also writes an accumulating plan document to `<project>/docs/plan/<slug>.md` (original spec + decision history + planner output). The review step checks for a `[VERDICT: SHIP]` marker; if present, the pipeline exits early. The final `cicd` step runs only when the planner assigns explicit CI/CD work; it is CI-first, and CD artifacts are generated only when deployment is explicitly requested. Pass `--steps` to run a subset, or `--iterations` to set the review/test repair-route limit (default 4, maximum 10).

## Dashboard

`./run serve` starts an HTTP server (default `http://127.0.0.1:8080`) with:

- Live agent status and daily run count
- Browser OAuth login modal shown when Claude Code is logged out, with a success confirmation in the same modal after authentication — dismissal lasts for the current tab session, while a new `anthropic_auth_failed` run shows it again; open the login URL and paste the browser's `code#state` to finish (loopback access only; tokens are never stored in the browser or database)
- Recent run history (agent, status, duration, output preview) — auto-refreshes every 10s; load more with the explicit `More` button
- Running jobs update live over SSE; click any run row to anchor the detail panel
- Running rows, the submit result panel, and the run detail panel provide a force-stop action that aborts the active provider process; cancelled runs are displayed as `CANCELLED`
- Claude login and organization subscription-denial responses are normalized to `anthropic_auth_failed`; when a different fallback model is configured it is tried once, otherwise the agent and linked spec workflow are recorded as `FAILED`
- Agent output is rendered as Markdown (sanitized) with a render/raw toggle
- When a spec run stops on clarifier questions, the detail panel shows answer fields (pre-filled with recommendations) to resume in place
- Auto-clarify can accept recommended answers automatically; its maximum rounds are configurable in the submit and stopped-run answer forms (`0` means unlimited and is the default), and the setting persists when a clarification run resumes
- The submit form lets you select workflow stages; planner stays enabled whenever a downstream implementation, test, review, or CI/CD stage is selected
- The submit form exposes the review/test repair-route limit (default 4, maximum 10); the setting persists across clarification, continuation, and resume-last runs
- The detail panel includes a workflow summary, terminal failure stage/reason, per-agent navigation, and token debug breakdown by agent/model/input/output
- The history table lists top-level requests first and keeps workflow sub-steps collapsible; completed spec runs get inline **continue** and **resume last step** buttons
- Any completed spec run can be continued with a free-text follow-up instruction, or resumed at the failed step, requested repair route, or next enabled step after the last successful run — the original spec, prior Q&A, and the new instruction are re-run as a fresh linked workflow
- Submit form: agent picker + project dropdown (workspace projects) + model/effort settings + request reset

If accessing from a remote machine over SSH, use local port forwarding:

```bash
ssh -L 8080:127.0.0.1:8080 user@host -N
```

## REST API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/status` | Agent list + run guard + circuit breaker stats |
| `GET` | `/api/auth/claude` | Get Claude Code authentication status (loopback dashboard only) |
| `POST` | `/api/auth/claude/login` | Start Claude.ai OAuth login and return the login URL |
| `POST` | `/api/auth/claude/code` | Submit browser `{ code }` (`code#state`) and finish authentication |
| `POST` | `/api/agents/:name` | Invoke a single agent (accepts `project`) |
| `POST` | `/api/clarify` | Run clarifier with Q&A context |
| `POST` | `/api/specs` | Run spec workflow |
| `GET` | `/api/integrations/openclaw/health` | OpenClaw local bridge account/health (loopback only) |
| `POST` | `/api/integrations/openclaw/specs` | Start a background OpenClaw spec; immediately return `202 + runId` |
| `POST` | `/api/llm/complete` | One-shot LLM completion proxy (external apps via subscription) |
| `GET` | `/api/runs` | Recent runs (`?units=` top-level units; returns `{ rows, hasMore }`) |
| `GET` | `/api/runs/:id` | Single run detail |
| `POST` | `/api/runs/:id/cancel` | Force-stop a running workflow or agent process |
| `GET` | `/api/runs/:id/clarification` | Pending clarifier questions for a stopped spec run |
| `POST` | `/api/runs/:id/answers` | Resume a clarified spec run with `{ answers }` (no spec re-entry) |
| `POST` | `/api/runs/:id/continue` | Continue a completed spec run with `{ instruction }` (no spec re-entry) |
| `POST` | `/api/runs/:id/resume-last` | Resume a spec run from the last executed workflow step |
| `GET` | `/api/runs/:id/events` | SSE — live events for a running job |
| `GET` | `/api/runs/:id/events/history` | Persisted event history for a run |
| `GET` | `/api/stats` | Aggregate stats by agent and status |
| `GET`/`POST` | `/api/config` | Get/set model, fallback, per-agent models & effort + project list |
| `GET` | `/api/issues` · `POST /api/issues/:key/run` | Issue-tracker fetch + auto-process |

## Configuration

Configuration can be changed from the dashboard settings panel. Runtime changes are saved to `AUTO_DEV_CONFIG_PATH` (default `./data/config.json`) and take precedence over environment variables. Environment variables are still supported for bootstrapping:

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTO_DEV_PROVIDER` | `anthropic` | LLM provider selection (`anthropic`, `codex-cli`, or `openai-compatible`) |
| `AUTO_DEV_MODEL` | (provider default) | Provider model to use |
| `AUTO_DEV_AGENT_<AGENT>_MODEL` | unset | Per-agent model override, e.g. `AUTO_DEV_AGENT_SCAFFOLD_MODEL` |
| `AUTO_DEV_FALLBACK_MODEL` | unset | Model to use when the selected global or per-agent model is unavailable |
| `AUTO_DEV_EFFORT` | `high` | Effort level (`low`–`max`; Codex currently exposes `low`/`medium`/`high`) |
| `AUTO_DEV_CONFIG_PATH` | `./data/config.json` | Dashboard-persisted runtime config file |
| `AUTO_DEV_CODEX_COMMAND` | `codex` | Codex CLI command when `AUTO_DEV_PROVIDER=codex-cli` |
| `AUTO_DEV_CODEX_TIMEOUT_MS` | `600000` | Codex CLI execution timeout |
| `AUTO_DEV_OPENAI_BASE_URL` | unset | OpenAI-compatible endpoint (NVIDIA NIM / DeepSeek / OpenRouter / vLLM). Text completion only — not tool-using agent steps |
| `AUTO_DEV_OPENAI_API_KEY` | unset | Bearer key for the OpenAI-compatible endpoint (unset ⇒ provider hidden) |
| `AUTO_DEV_OPENAI_MODELS` | unset | Comma-separated model ids to expose, e.g. `deepseek-ai/deepseek-v4-pro` |
| `AUTO_DEV_OPENAI_MAX_TOKENS` | unset | Optional `max_tokens` sent with each request |
| `AUTO_DEV_WORKSPACE_ROOT` | `./data/workspace` | Root for project-name resolution |
| `AUTO_DEV_RUN_AS_USER` | `shin` | Non-root user `scripts/serve.sh` drops to when started as root |
| `AUTO_DEV_DB_PATH` | `./data/auto-dev.db` | SQLite database path |
| `AUTO_DEV_BIND_ADDR` | `127.0.0.1` | HTTP server bind address |
| `AUTO_DEV_BIND_PORT` | `8080` | HTTP server port |
| `AUTO_DEV_DAILY_RUN_LIMIT` | `100` | Max agent runs per day (empty = unlimited) |
| `AUTO_DEV_OPENCLAW_ENABLED` | `false` | Enable OpenClaw Telegram terminal-state notifications |
| `AUTO_DEV_OPENCLAW_ACCOUNT` | `main` | OpenClaw Telegram account used for notifications |
| `AUTO_DEV_OPENCLAW_COMMAND` | `openclaw` | OpenClaw CLI command or absolute path |
| `AUTO_DEV_OPENCLAW_CONFIG_PATH` | `~/.openclaw/openclaw.json` | OpenClaw config used to resolve the account allowlist |
| `AUTO_DEV_OPENCLAW_TARGET` | account `allowFrom[0]` | Explicit Telegram chat ID override |
| `AUTO_DEV_OPENCLAW_API_TOKEN` | unset | Optional Bearer token for the loopback bridge |
| `AUTO_DEV_ISSUE_TRACKER_URL` | (none) | Issue-tracker URL — enables integration when set |
| `AUTO_DEV_WORKLOG_BRIEFING_ENABLED` | `false` | Enable daily review briefing cron |
| `AUTO_DEV_WORKLOG_BRIEFING_CRON` | `0 9 * * *` | Cron expression for briefing schedule |

## Project structure

```
auto-dev-ts/
├── prompts/          System prompts for each agent (Markdown)
├── deploy/systemd/   User-service template independent of SSH sessions
├── integrations/     OpenClaw workspace skill + deterministic bridge script
├── scripts/          Ops scripts (non-root launcher + user-service installer)
├── static/           Dashboard frontend (vanilla HTML/JS)
├── src/
│   ├── agents/       Agent implementations + registry
│   │   └── review/   Multi-lens review orchestrator + lens definitions
│   ├── workflows/    SpecWorkflow + issue-driven workflow
│   ├── llm/          LLM provider seam (registry + anthropic/codex impls)
│   ├── integrations/ issue-tracker client + OpenClaw Telegram notifications
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
