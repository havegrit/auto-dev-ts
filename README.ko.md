# auto-dev

[Claude Code SDK](https://github.com/anthropics/claude-agent-sdk-typescript) 기반 개발 자동화 에이전트. 스캐폴딩, 코드 리뷰, 테스트, CI/CD, 플래닝, 스펙 정제를 담당하는 6개의 전문 AI 에이전트를 오케스트레이션합니다. LLM API 키나 토큰 비용 없이 동작합니다.

> [English documentation](README.md)

## 동작 방식

클라우드 LLM API를 직접 호출하는 대신, Agent SDK를 통해 **Claude Code** CLI를 프로그래밍으로 제어합니다. 각 에이전트는 워크스페이스 디렉토리로 파일 I/O와 쉘 접근이 제한된 Claude Code 세션 안에서 실행됩니다. 리뷰 에이전트는 정확성 · 보안 · 성능 · 스타일 4개 서브에이전트를 동시에 병렬 실행합니다.

planner가 작업을 dependency DAG로 분해해 `TEAM_PLAN`을 반환하면 독립 task는 동시에
실행됩니다. 수정 task는 별도 git worktree에서 실행되고 결과는 자동 통합됩니다.
충돌 시 내부 integrator가 해결을 시도합니다. 기존 `PLAN`만 반환하는 실행은 기존
순차 workflow로 fallback하며, 팀 중첩은 최대 2단계입니다.

모든 실행 기록은 로컬 SQLite 데이터베이스에 저장되며, 내장 웹 대시보드에서 확인할 수 있습니다.

## 에이전트

| 에이전트 | 설명 |
|---------|------|
| `scaffold` | 스펙 또는 설명에서 코드 스켈레톤 생성 |
| `review` | 멀티 렌즈 코드 리뷰: 정확성 · 보안 · 성능 · 스타일 (병렬) |
| `test` | 기존 코드에 대한 테스트 케이스 생성 |
| `cicd` | CI-first 파이프라인 설정 생성, CD는 명시적 요청일 때만 |
| `planner` | 스펙에서 구조화된 개발 계획 수립 |
| `clarifier` | 플래닝 전 스펙의 불명확한 점 파악 |

## 요구사항

- [Claude Code](https://claude.ai/code) 설치 및 인증 완료 (`claude`가 PATH에 있어야 함), 또는 `AUTO_DEV_PROVIDER=codex-cli` 사용 시 Codex CLI 설치 및 인증 완료
- Node.js ≥ 22
- npm

## 설치

```bash
git clone <repo>
cd auto-dev-ts
npm install
cp .env.example .env
```

`.env` 파일을 필요에 맞게 수정합니다 (워크스페이스 경로, 포트, 일일 실행 제한 등).

## 사용법

입력은 인라인 문자열 또는 파일 경로 모두 가능하며, 자동으로 감지됩니다.

```bash
# 단일 에이전트 실행
./run scaffold "JWT 인증을 포함한 REST API를 만들어줘"
./run scaffold path/to/spec.md

./run review src/
./run test src/auth.ts
./run cicd --cd "Node.js 모노레포, AWS ECS 배포"
./run planner path/to/spec.md
./run clarifier path/to/spec.md

# 전체 스펙 워크플로우 (clarifier → planner → scaffold → test → review → cicd)
./run spec path/to/spec.md

# 특정 단계만 실행
./run spec path/to/spec.md --steps scaffold,test,review

# 현황 및 통계
./run status

# HTTP API + 대시보드
./run serve          # 또는: npm run serve:user  ("비-root 실행" 참고)

# SSH 세션과 독립된 user service 설치/시작
npm run service:install
npm run service:start
npm run service:status

# 스케줄러만 실행 (일일 워크로그 브리핑)
./run daemon
```

### 비-root 실행

Claude Code SDK는 각 에이전트를 `--dangerously-skip-permissions`로 실행하는데,
Claude Code는 **root/sudo에서 이 플래그를 거부**합니다. auto-dev를 root로 실행하면
모든 SDK 호출(모델 조회·에이전트 실행·완성)이 `Claude Code process exited with code 1`로
실패합니다. 일반 유저로 실행하세요.

서버는 `npm run serve:user`(→ `scripts/serve.sh`)가 root 감지 시 비-root 유저
(`AUTO_DEV_RUN_AS_USER`, 기본 `shin`)로 권한을 낮춰 실행합니다. 해당 유저는 자체 Claude
자격증명(`~/.claude/.credentials.json`)이 필요합니다. 샌드박스 컨테이너용 임시 우회책:
`IS_SANDBOX=1` 설정.

### SSH 종료 후에도 서버 유지

`./run serve`를 SSH 터미널의 foreground에서 실행하면 터미널 종료 시 서버와 실행 중인
스펙도 함께 종료될 수 있습니다. `npm run service:install`은 현재 프로젝트 절대 경로로
`~/.config/systemd/user/auto-dev.service`를 생성하고 enable합니다. 이후
`npm run service:start`로 시작하면 서버와 provider 자식 프로세스가 SSH 세션에서
분리되고, 비정상 종료 시 자동 재시작됩니다.

user service가 로그아웃 뒤에도 유지되려면 linger가 필요합니다. 설치 스크립트가 상태를
검사하고 꺼져 있으면 `sudo loginctl enable-linger <user>` 명령을 안내합니다. 로그는
`npm run service:logs`로 확인합니다. 같은 포트에서 `./run serve`와 service를 동시에
실행하지 마세요.

대시보드가 시작한 스펙은 HTTP 응답과 분리된 background 작업이므로 브라우저나 SSH
포트 포워딩을 닫아도 service 안에서 계속됩니다. 단, 호스트 재부팅이나 service
재시작까지 이어가는 durable job queue/checkpoint 복구는 아직 지원하지 않으며, 이 경우
실행 중 레코드는 `server_restart` 실패로 정리됩니다.

### OpenClaw + Telegram

기존 OpenClaw Telegram 계정을 수신 게이트웨이로 재사용할 수 있습니다. 별도 공개
도메인·웹훅·auto-dev 폴링은 필요 없습니다. OpenClaw가 Telegram 메시지를 받고,
`integrations/openclaw/skills/auto-dev-spec` skill이 루프백 API로 background spec을
시작합니다. 완료·실패·취소·추가 입력 필요 알림은 auto-dev가 OpenClaw의 지정 계정으로
직접 전송합니다.

```bash
# .env
AUTO_DEV_OPENCLAW_ENABLED=true
AUTO_DEV_OPENCLAW_ACCOUNT=main
AUTO_DEV_OPENCLAW_COMMAND=/home/user/.local/bin/openclaw
AUTO_DEV_OPENCLAW_CONFIG_PATH=/home/user/.openclaw/openclaw.json

# OpenClaw가 repo skill root를 읽도록 설정 후 gateway 재시작
openclaw config set skills.load.extraDirs \
  '["/absolute/path/auto-dev-ts/integrations/openclaw/skills"]' --strict-json
```

Telegram에서는 자연어로 auto-dev 실행을 요청하거나
`/auto_dev_spec <요청>` 또는 `/skill auto-dev-spec <요청>`을 사용합니다. 상태 조회와
취소도 run ID를 포함해 요청할 수 있습니다. integration API는
`AUTO_DEV_BIND_ADDR=127.0.0.1`일 때만 허용되며, 필요하면
`AUTO_DEV_OPENCLAW_API_TOKEN`을 auto-dev와 OpenClaw 실행 환경에 같이 설정합니다.

## 스펙 워크플로우

`./run spec <file>`은 아래 순서로 전체 파이프라인을 실행합니다:

```
clarifier → planner → scaffold → test → review → cicd
```

`clarifier`가 요구사항이 아직 구현 가능한 수준이 아니라고 판단하면 planner/scaffold로 넘어가지 않고 추천 답안을 포함한 질문을 반환한 뒤 멈춥니다. 대시보드에서는 그 질문에 바로 답하면 **스펙을 다시 입력하지 않고** 재개됩니다 — 답변이 원본 스펙과 합쳐져 연결된 새 run으로 진행되며, clarifier가 또 물으면 반복됩니다. 각 spec 세션은 `<project>/docs/plan/<slug>.md`에 plan 문서(원본 스펙 + 의사결정 히스토리 + planner 산출물)를 누적 기록합니다. 리뷰 단계에서 `[VERDICT: SHIP]` 마커가 확인되면 파이프라인이 조기 종료됩니다. 마지막 `cicd` 단계는 planner가 명시적인 CI/CD 작업을 할당할 때만 실행되며, 기본은 CI이고 배포 요청이 명시된 경우에만 CD 산출물을 만듭니다. `--steps`로 실행할 단계를 지정하거나, `--iterations`로 review/test 재작업 라우팅 상한(기본 4, 최대 10)을 설정할 수 있습니다.

## 대시보드

`./run serve`로 HTTP 서버를 시작합니다 (기본값: `http://127.0.0.1:8080`).

- 에이전트 현황 및 일일 실행 횟수
- Claude Code 로그아웃 감지 시 브라우저 OAuth 로그인 모달 표시, 인증 완료 시 같은 모달에서 성공 확인 표시 — 닫으면 같은 탭 세션에서는 숨기고, 새 `anthropic_auth_failed` 실행이 발생하면 다시 표시; 로그인 URL을 열고 브라우저의 `code#state`를 붙여넣어 완료 (루프백 접속 전용, 토큰은 브라우저나 DB에 저장하지 않음)
- 최근 실행 목록 (에이전트, 상태, 소요시간, 출력 미리보기) — 10초마다 자동 갱신, `더 보기` 버튼으로 추가 로드
- 실행 중인 작업은 SSE로 라이브 갱신, 실행 행 클릭 시 상세 패널로 앵커 이동
- 실행 중인 행, 제출 결과 패널, 실행 상세 패널에서 강제 중단 가능; 실제 provider 프로세스를 중단하고 UI에는 `CANCELLED`로 표시
- Claude 로그인 및 조직 구독 권한 거부 응답은 `anthropic_auth_failed`로 정규화; 다른 fallback 모델이 설정돼 있으면 1회 재시도하고, 없거나 재시도도 실패하면 해당 에이전트와 연결된 spec을 `FAILED`로 기록
- 에이전트 출력은 마크다운으로 렌더링(살균 처리), 렌더/원본 토글 제공
- spec run이 clarifier 질문에서 멈추면 상세 패널에 답변 입력란(추천 답안 미리 채움)이 떠 그 자리에서 재개
- 자동 구체화는 추천 답안을 자동 승인하며, 제출 폼과 중단된 run의 답변 폼에서 최대 라운드를 조절할 수 있음 (`0`은 무제한이며 기본값); 중단 후 재개해도 설정 유지
- 새 요청 폼에서 실행 단계를 선택할 수 있으며, 구현·테스트·리뷰·CI/CD 후속 단계를 선택하면 planner는 필수로 유지
- 새 요청 폼에서 review/test 재작업 라우팅 상한(기본 4, 최대 10)을 설정할 수 있으며, 질문 답변·후속 실행·마지막 단계 재개 시에도 설정 유지
- 상세 패널은 workflow 요약, 종료 실패 단계·원인, 에이전트 간 이동, agent/model/input/output 기준 token debug breakdown 제공
- 이력 표는 최상위 요청을 우선 표시하고 워크플로우 하위 단계는 접기/펼치기로 확인 가능, 완료된 spec run에는 행에서 바로 **재실행** 및 **마지막 단계부터 재개** 버튼 제공
- 완료된 spec run은 자유 텍스트 후속 지시로 다시 실행하거나 실패 단계·요청된 재작업 경로·마지막 성공 단계 다음의 활성 단계부터 재개할 수 있음 — 원본 스펙 + 이전 Q&A + 새 지시를 합쳐 연결된 새 워크플로우로 재실행
- 작업 제출: 에이전트 선택 + 프로젝트 드롭다운(워크스페이스 프로젝트) + 모델/effort 설정 + 요청 초기화

원격 서버에 SSH로 접속 중이라면 로컬 포트 포워딩을 사용합니다:

```bash
ssh -L 8080:127.0.0.1:8080 user@host -N
```

## REST API

| 메서드 | 경로 | 설명 |
|--------|------|------|
| `GET` | `/api/status` | 에이전트 목록 + 실행 가드 + 회로차단기 통계 |
| `GET` | `/api/auth/claude` | Claude Code 인증 상태 조회 (루프백 대시보드 전용) |
| `POST` | `/api/auth/claude/login` | Claude.ai OAuth 로그인 시작 및 로그인 URL 반환 |
| `POST` | `/api/auth/claude/code` | 브라우저에서 받은 `{ code }` (`code#state`) 제출 및 인증 완료 |
| `POST` | `/api/agents/:name` | 단일 에이전트 실행 (`project` 지정 가능) |
| `POST` | `/api/clarify` | Q&A 컨텍스트와 함께 clarifier 실행 |
| `POST` | `/api/specs` | 스펙 워크플로우 실행 |
| `GET` | `/api/integrations/openclaw/health` | OpenClaw 로컬 bridge 상태/계정 조회 (루프백 전용) |
| `POST` | `/api/integrations/openclaw/specs` | OpenClaw에서 background spec 시작, 즉시 `202 + runId` 반환 |
| `POST` | `/api/llm/complete` | 단발성 LLM 생성 프록시 (외부 앱이 구독으로 호출) |
| `GET` | `/api/runs` | 최근 실행 목록 (`?units=` 최상위 유닛, `{ rows, hasMore }` 반환) |
| `GET` | `/api/runs/:id` | 단일 실행 상세 |
| `POST` | `/api/runs/:id/cancel` | 실행 중인 워크플로우 또는 에이전트 프로세스 강제 중단 |
| `GET` | `/api/runs/:id/clarification` | 멈춘 spec run 의 대기 중 clarifier 질문 |
| `POST` | `/api/runs/:id/answers` | `{ answers }` 로 spec 워크플로우 재개 (스펙 재입력 불필요) |
| `POST` | `/api/runs/:id/continue` | `{ instruction }` 로 완료된 spec run 이어가기 (스펙 재입력 불필요) |
| `POST` | `/api/runs/:id/resume-last` | 마지막으로 실행된 워크플로우 단계부터 재개 |
| `GET` | `/api/runs/:id/events` | SSE — 실행 중 라이브 이벤트 |
| `GET` | `/api/runs/:id/events/history` | 실행 이력에 저장된 이벤트 기록 |
| `GET` | `/api/stats` | 에이전트 · 상태별 집계 통계 |
| `GET`/`POST` | `/api/config` | 모델/fallback/에이전트별 모델/effort 조회·변경 + 프로젝트 목록 |
| `GET` | `/api/issues` · `POST /api/issues/:key/run` | issue-tracker 조회 + 자동 처리 |

## 설정

설정은 대시보드의 설정 패널에서 변경할 수 있습니다. 런타임 변경값은 `AUTO_DEV_CONFIG_PATH`(기본 `./data/config.json`)에 저장되며 환경 변수보다 우선합니다. 환경 변수는 초기 부트스트랩 설정으로 계속 사용할 수 있습니다:

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `AUTO_DEV_PROVIDER` | `anthropic` | LLM 프로바이더 선택 (`anthropic` 또는 `codex-cli`) |
| `AUTO_DEV_MODEL` | (프로바이더 기본) | 사용할 프로바이더 모델 |
| `AUTO_DEV_AGENT_<AGENT>_MODEL` | 미설정 | 에이전트별 모델 override. 예: `AUTO_DEV_AGENT_SCAFFOLD_MODEL` |
| `AUTO_DEV_FALLBACK_MODEL` | 미설정 | 선택한 전역/에이전트별 모델을 사용할 수 없을 때 쓸 폴백 모델 |
| `AUTO_DEV_EFFORT` | `high` | effort 레벨 (`low`~`max`; Codex는 현재 `low`/`medium`/`high` 노출) |
| `AUTO_DEV_CONFIG_PATH` | `./data/config.json` | 대시보드에서 저장한 런타임 설정 파일 |
| `AUTO_DEV_CODEX_COMMAND` | `codex` | `AUTO_DEV_PROVIDER=codex-cli`일 때 사용할 Codex CLI 명령 |
| `AUTO_DEV_CODEX_TIMEOUT_MS` | `600000` | Codex CLI 실행 timeout |
| `AUTO_DEV_WORKSPACE_ROOT` | `./data/workspace` | 프로젝트명 해석 기준 루트 |
| `AUTO_DEV_RUN_AS_USER` | `shin` | root로 시작 시 `scripts/serve.sh`가 권한을 낮출 비-root 유저 |
| `AUTO_DEV_DB_PATH` | `./data/auto-dev.db` | SQLite 데이터베이스 경로 |
| `AUTO_DEV_BIND_ADDR` | `127.0.0.1` | HTTP 서버 바인드 주소 |
| `AUTO_DEV_BIND_PORT` | `8080` | HTTP 서버 포트 |
| `AUTO_DEV_DAILY_RUN_LIMIT` | `100` | 일일 실행 횟수 한도 (비우면 무제한) |
| `AUTO_DEV_OPENCLAW_ENABLED` | `false` | OpenClaw Telegram 완료/실패 알림 활성 |
| `AUTO_DEV_OPENCLAW_ACCOUNT` | `main` | 알림에 사용할 OpenClaw Telegram 계정 |
| `AUTO_DEV_OPENCLAW_COMMAND` | `openclaw` | OpenClaw CLI 명령 또는 절대 경로 |
| `AUTO_DEV_OPENCLAW_CONFIG_PATH` | `~/.openclaw/openclaw.json` | 대상 allowlist를 읽을 OpenClaw 설정 |
| `AUTO_DEV_OPENCLAW_TARGET` | 계정 `allowFrom[0]` | 명시적 Telegram chat ID override |
| `AUTO_DEV_OPENCLAW_API_TOKEN` | 미설정 | 루프백 bridge 선택적 Bearer 토큰 |
| `AUTO_DEV_ISSUE_TRACKER_URL` | (없음) | issue-tracker URL — 설정 시 연동 활성 |
| `AUTO_DEV_WORKLOG_BRIEFING_ENABLED` | `false` | 일일 리뷰 브리핑 스케줄러 활성화 |
| `AUTO_DEV_WORKLOG_BRIEFING_CRON` | `0 9 * * *` | 브리핑 스케줄 크론 표현식 |

## 프로젝트 구조

```
auto-dev-ts/
├── prompts/          각 에이전트 시스템 프롬프트 (Markdown)
├── deploy/systemd/   SSH와 독립된 user service 템플릿
├── integrations/     OpenClaw workspace skill + deterministic bridge script
├── scripts/          운영 스크립트 (비-root 런처 + user service 설치)
├── static/           대시보드 프론트엔드 (바닐라 HTML/JS)
├── src/
│   ├── agents/       에이전트 구현체 및 레지스트리
│   │   └── review/   멀티 렌즈 리뷰 오케스트레이터 + 렌즈 정의
│   ├── workflows/    SpecWorkflow + 이슈 기반 워크플로우
│   ├── llm/          LLM 프로바이더 seam (registry + anthropic/codex 구현)
│   ├── integrations/ issue-tracker 클라이언트 + OpenClaw Telegram 알림
│   ├── store/        SQLite 스키마 + CRUD
│   ├── lib/          러너, 가드, 회로차단기, SSE, 워크스페이스 해석 등
│   ├── server/       Hono HTTP 서버 + 라우트
│   ├── schedule/     node-cron 일일 브리핑
│   └── cli.ts        Commander CLI 진입점
├── .env.example
├── package.json
└── tsconfig.json
```

## 라이선스

MIT
