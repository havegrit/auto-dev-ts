# auto-dev

Development automation agent powered by [Claude Code SDK](https://github.com/anthropics/claude-agent-sdk-typescript). Orchestrates six specialized AI agents to automate scaffolding, code review, testing, CI/CD, planning, and spec clarification — without any LLM API key or per-token cost.

> [한국어 문서](README.ko.md)

## How it works

Instead of calling a cloud LLM API directly, auto-dev drives **Claude Code** (the CLI) programmatically via the Agent SDK. Each agent runs inside a Claude Code session with file I/O and shell access scoped to a workspace directory. The review agent fans out to four parallel sub-agents (correctness, security, performance, style) simultaneously.

When the planner emits a `TEAM_PLAN` dependency DAG, independent tasks run in parallel in
isolated git worktrees and are integrated automatically. Legacy `PLAN` output falls back to
the sequential workflow; nested teams are limited to two levels.

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
- Node.js ≥ 24
- npm

## Setup

```bash
git clone <repo>
cd auto-dev-ts
npm install
cp .env.example .env
```

Edit `.env` as needed (workspace root, port, daily run limit).

### Docker Compose

The development container persists the source, DB/workspace data, and Claude/Codex
credentials in separate volumes. It runs as the non-root `app` user with a healthcheck
and `restart: unless-stopped`.

```bash
cp .env.example .env
docker compose build
bash docker/seed-claude.sh       # once: copy host Claude OAuth credentials
docker compose up -d
docker compose ps
docker compose logs -f auto-dev
```

The dashboard is available at `http://127.0.0.1:8080`. For another instance, use a
separate clone directory and separate `AUTO_DEV_HOST_PORT`/Compose project name. Back up
the SQLite DB with:

```bash
docker compose exec auto-dev npm run backup:db
```

The production image is available behind a separate profile:

```bash
docker compose --profile prod up -d auto-dev-prod
```

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

# Run the built-in evaluation cases
./run eval
./run eval --case typescript-even-bug --models anthropic:claude-sonnet-5,codex-cli:gpt-5.5

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

### Operational notes

The Claude Code SDK runs each agent with `--dangerously-skip-permissions`, which
Claude Code **refuses under root/sudo**. Running auto-dev as root makes every SDK
call fail with `Claude Code process exited with code 1` (model discovery, agent
runs, completions). Run it as a regular user instead.

For the server, `npm run serve:user` (→ `scripts/serve.sh`) drops from root to a non-root
user (`AUTO_DEV_RUN_AS_USER`, default `shin`) before starting. That user needs its own Claude
credentials (`~/.claude/.credentials.json`). For sandboxed containers, set `IS_SANDBOX=1`.

To keep the server alive after SSH exits, install the user service:

Running `./run serve` in an SSH foreground terminal can terminate the server and its
active specs when that terminal closes. `npm run service:install` writes and enables
`~/.config/systemd/user/auto-dev.service` using the current project's absolute path.
Start it with `npm run service:start`; the server and provider child processes then run
outside the SSH session and restart after an unexpected process failure.

The user service requires linger to survive logout; the installer reports the required
`sudo loginctl enable-linger <user>` command when needed. Read logs with
`npm run service:logs`. Do not run `./run serve` and the service on the same port.

Dashboard specs already run in the service background, independently of the HTTP
response, so closing the browser or SSH port-forward does not cancel them. A project can
opt into checkpoint recovery with `workflow.resumeOnRestart: true` in
`.auto-dev/project.json`. It requires a clean Git worktree when the run starts. Completed
agent results are consumed after restart; an interrupted read-only agent is retried only
when its pre-run workspace hashes and Git HEAD still match. Interrupted write-capable agents,
team, verify, runtime, or post-success delivery actions stop as `RECOVERY_REQUIRED` and
preserve the workspace for inspection. Projects without this setting keep the legacy
`server_restart` failure behavior. Run-isolated worktrees are not part of this first slice.

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

After the enabled workflow stages finish successfully, two internal post-success agents run in the background in a fixed order: `checking-docs-before-commit` audits and updates stale documentation, then `atomic-commit` stages only spec-related files or hunks and creates verified atomic commits. They load the globally installed skill instructions from `~/.codex/skills` or `~/.claude/skills` (override the skill root with `AUTO_DEV_SKILLS_ROOT`). Clarification waits, failed/cancelled workflows, and incomplete safety-limit exits never commit. Post-success runs are separate from the spec workflow and do not change its completed status; failures are logged independently.

### Auto-dev evaluation

`./run eval` runs every `evals/cases/<case-id>/` fixture; use `--case <id>` to select one or `--models id1,id2` to run a model matrix. Each case has `spec.md`, `fixture/`, `checks.sh`, and `meta.json`. The evaluator copies the fixture into a temporary workspace, runs `runSpec` with `triggerSource: eval`, applies the normal daily run limit, then checks the expected verdict and script exit code. Model overrides are isolated to each asynchronous workflow and do not change saved settings. Results include route count, token usage, duration, check output, and pass/fail changes against the previous run in `data/evals/<timestamp>.json`. Eval runs do not schedule post-success commits. The Spring/PostgreSQL case requires Maven, Docker Compose, and dependency access; the TypeScript case requires Node.js 24.

### Deterministic verification gate

When the target project declares how to verify itself in `<project>/.auto-dev/project.json`, a `[TESTS: PASS]` marker is no longer taken at face value: **the orchestrator runs that command itself and the exit code decides**.

```json
{
  "version": 1,
  "verify": { "command": "./gradlew check", "timeoutMs": 900000 },
  "runtime": {
    "up": "docker compose up -d --wait",
    "down": "docker compose down -v",
    "healthcheck": { "url": "http://localhost:8080/actuator/health", "timeoutMs": 120000 },
    "checks": [".auto-dev/checks/smoke.sh"]
  },
  "roleBoundary": {
    "testGlobs": ["src/test/**", "**/*.test.ts"],
    "ignoreGlobs": []
  }
}
```

- If `verify.command` exits non-zero or times out, the PASS marker is ignored and the output tail is routed back to the planner as feedback. Once the repair-route budget is exhausted the workflow fails with `verify_failed`.
- Each run is recorded as an `agent_name='verify'` row, so the dashboard workflow detail shows the exit-code summary, duration, and output tail. Cancelling from the dashboard tears down the whole process group.
- Declaring `roleBoundary.testGlobs` enables a post-hoc check: file content hashes are compared before and after the test step, and editing anything outside the test paths fails the run with `role_boundary_violation` (reported, never reverted).
- Without this file the project-configured verify/runtime gates are inactive and ordinary workflows behave as before. Bug issues still use the repro-first path below, with built-in test-file globs when no role-boundary globs are configured. If the file exists but its schema is wrong, the run fails immediately.

Dashboard runs can additionally opt into restart checkpoints with
`"workflow": { "resumeOnRestart": true }`. This setting requires a clean Git worktree at
launch. Completed agent results are reused and unchanged read-only steps can retry; interrupted
write-capable/team/verify/runtime/delivery work or changed workspace state is shown as
`RECOVERY_REQUIRED` in the dashboard.
See the operational notes above for the current scope and limits.

When `runtime` is configured, a `[TESTS: PASS]` run continues through the `verify` command, runtime startup, HTTP healthcheck, deterministic scripts, and a fresh `verifier` session before review. Any startup, healthcheck, check, or behavior-verification failure is recorded with evidence and routed back to the planner. Runtime `down` runs from `finally`, including on cancellation. The orchestrator sets `COMPOSE_PROJECT_NAME=autodev-<workflow id prefix>` for runtime commands and verifier tools.

Runtime observations are stored in `data/evidence/<workflowRunId>/evidence.json`. The workflow detail view and `GET /api/runs/:id/evidence` expose request/response summaries, command output tails, and the verifier report. Compose project names isolate container resources; published host ports still need a project-specific variable, for example `ports: ["${WEB_PORT:-8080}:8080"]`.

The internal `verifier` gets `Read` and `Bash` in a new run, plus the feature map. It checks the running behavior and reports `[VERIFY: PASS]`, `[VERIFY: FAIL]`, or `[VERIFY: BLOCKED]`. A workspace snapshot detects verifier edits and fails the gate without reverting them.

### Bug issues: reproduce before fixing

An issue whose type is exactly `BUG` (case-insensitive) starts in repro mode. The test agent may write test files only and must return `[REPRO: <command>]`. The orchestrator runs that command from the project workspace before changing the issue status. If it passes, the issue stays in its original state and the workflow returns `BLOCKED` with cause `not_reproduced`.

After a failing repro is observed, the issue moves to `IN_PROGRESS` and the planner/scaffold fix loop starts. The same command must pass after the fix, before the configured verify/runtime gates and review. Other issue types keep the existing spec workflow.

### Review findings and rule candidates

The review prompt emits one `FINDINGS_JSON` block before its existing verdict markers. Valid findings are stored in `review_finding`; a malformed or missing block adds a warning event and does not fail the run. Verify failures and role-boundary violations use the same table. The daily briefing and dashboard show the most frequent `category + rule_hint` pairs from the last 14 days, grouped by project. Promote a candidate to the target repository's `AGENTS.md` or a hard test/static-analysis rule only after human review.

### Project context

Agents use target-repository knowledge when it is available:

- `AGENTS.md` supplies project-specific working rules. If it is absent, Anthropic runs use the `CLAUDE.md` already loaded by the Claude Agent SDK; other providers receive that file in the prompt.
- `.auto-dev/feature-map.md` describes how to run the service, exercise endpoints, inspect data, and follow package boundaries.
- Planner, scaffold, test, and review receive both sources. Clarifier and the runtime verifier receive only the feature map in their added context. Review lenses receive the same context as the review agent.
- Combined context is capped at 16 KiB. Oversized content is truncated with a marker; missing files are skipped.
- Anthropic's SDK may still load `CLAUDE.md` by its default project-memory behavior, including for clarifier; auto-dev avoids adding the same file to the prompt a second time.

Start from [`docs/templates/feature-map.md`](docs/templates/feature-map.md).

## Dashboard

`./run serve` starts an HTTP server (default `http://127.0.0.1:8080`) with:

- Live agent status and daily run count
- Browser OAuth login for Claude Code, including fallback-model retry and normalized failure states
- Live run history and status updates with elapsed time, token usage, Markdown output, and cancellation
- Clarifier answers, follow-up instructions, and resume-from-step actions without re-entering the spec
- Stage-based agent/workflow submission with project, model, effort, and repair-limit settings
- Spec submission with text and multiple reference-context files together (any extension; 2 MB per file, 10 MB total; binaries are passed by path)
- Workflow details, per-agent navigation, failure reasons, and token breakdowns
- Runtime verification evidence, including healthcheck responses, check output, and verifier report
- AI chat for general questions and read-only project Q&A; chat history remains in browser `localStorage`
- Project context is filtered server-side to README and safe text files within the project

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
| `POST` | `/api/chat` | NDJSON streaming chat; optional read-only project context, selected model, recent messages, and relevant browser memory |
| `POST` | `/api/chat/memory` | Compress client-supplied conversation into topic-grouped Markdown memory; server does not persist it |
| `GET` | `/api/runs` | Recent runs (`?units=` top-level units; returns `{ rows, hasMore }`) |
| `GET` | `/api/runs/:id` | Single run detail |
| `GET` | `/api/runs/:id/checkpoint` | Opt-in workflow restart-recovery state |
| `GET` | `/api/runs/:id/evidence` | Runtime verification request/response and verifier evidence |
| `POST` | `/api/runs/:id/cancel` | Force-stop a running workflow or agent process |
| `GET` | `/api/runs/:id/clarification` | Pending clarifier questions for a stopped spec run |
| `POST` | `/api/runs/:id/answers` | Resume a clarified spec run with `{ answers }` (no spec re-entry) |
| `POST` | `/api/runs/:id/continue` | Continue a completed spec run with `{ instruction }` (no spec re-entry) |
| `POST` | `/api/runs/:id/resume-last` | Resume a spec run from the last executed workflow step |
| `GET` | `/api/runs/:id/events` | SSE — live events for a running job |
| `GET` | `/api/runs/:id/events/history` | Persisted event history for a run |
| `GET` | `/api/review-findings/candidates` | Project-grouped review and verification rule candidates from the last 14 days |
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
| `AUTO_DEV_SKILLS_ROOT` | `~/.codex/skills`, then `~/.claude/skills` | Optional global skill root override used by successful-spec commit processing |
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
├── evals/            Fixed evaluation cases and target-project fixtures
├── deploy/systemd/   User-service template independent of SSH sessions
├── integrations/     OpenClaw workspace skill + deterministic bridge script
├── scripts/          Ops scripts (non-root launcher + user-service installer)
├── static/           Dashboard frontend + floating chat widget (vanilla HTML/CSS/JS)
├── src/
│   ├── agents/       Agent implementations + registry
│   │   └── review/   Multi-lens review orchestrator + lens definitions
│   ├── workflows/    SpecWorkflow + verification gates + issue and eval workflows
│   ├── llm/          LLM provider seam (registry + anthropic/codex impls)
│   ├── integrations/ issue-tracker client + OpenClaw Telegram notifications
│   ├── store/        SQLite schema + CRUD
│   ├── lib/          Runner, guards, circuit breaker, SSE, workspace resolver,
│   │                 project config, verify executor, role-boundary check
│   ├── server/       Hono HTTP server + routes
│   ├── schedule/     node-cron daily briefing
│   └── cli.ts        Commander CLI entry point
├── .env.example
├── package.json
└── tsconfig.json
```

## License

MIT
