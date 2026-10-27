# auto-dev

[Claude Code SDK](https://github.com/anthropics/claude-agent-sdk-typescript) 기반 개발 자동화 에이전트. 스캐폴딩, 코드 리뷰, 테스트, CI/CD, 플래닝, 스펙 정제를 담당하는 6개의 전문 AI 에이전트를 오케스트레이션합니다. LLM API 키나 토큰 비용 없이 동작합니다.

> [English documentation](README.md)

## 동작 방식

클라우드 LLM API를 직접 호출하는 대신, Agent SDK를 통해 **Claude Code** CLI를 프로그래밍으로 제어합니다. 각 에이전트는 워크스페이스 디렉토리로 파일 I/O와 쉘 접근이 제한된 Claude Code 세션 안에서 실행됩니다. 리뷰 에이전트는 정확성 · 보안 · 성능 · 스타일 4개 서브에이전트를 동시에 병렬 실행합니다.

planner가 dependency DAG인 `TEAM_PLAN`을 반환하면 독립 task를 별도 git worktree에서 동시에 실행하고 결과를 자동 통합합니다. 기존 `PLAN`만 반환하는 실행은 순차 workflow로 fallback하며, 팀 중첩은 최대 2단계입니다.

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
- Node.js ≥ 24
- npm

## 설치

```bash
git clone <repo>
cd auto-dev-ts
npm install
cp .env.example .env
```

`.env` 파일을 필요에 맞게 수정합니다 (워크스페이스 경로, 포트, 일일 실행 제한 등).

### Docker Compose

개발용 컨테이너는 소스, DB/workspace 데이터, Claude/Codex 자격증명을 분리된 volume으로
보존합니다. 컨테이너는 non-root `app` 사용자로 실행되며, healthcheck와
`restart: unless-stopped`가 설정되어 있습니다.

```bash
cp .env.example .env
docker compose build
bash docker/seed-claude.sh       # 최초 1회: 호스트 Claude OAuth 자격증명 복사
docker compose up -d
docker compose ps
docker compose logs -f auto-dev
```

대시보드는 `http://127.0.0.1:8080`에서 확인합니다. 다른 인스턴스를 추가할 때는 별도
clone 디렉터리에서 `.env`의 `AUTO_DEV_HOST_PORT`와 Compose project name을 분리합니다.
SQLite DB 백업:

```bash
docker compose exec auto-dev npm run backup:db
```

prod 이미지는 별도 profile로 실행할 수 있습니다.

```bash
docker compose --profile prod up -d auto-dev-prod
```

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

# 기본 평가 케이스 실행 / 모델 비교
./run eval
./run eval --case typescript-even-bug --models anthropic:claude-sonnet-5,codex-cli:gpt-6.1-sol

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

### 운영 시 참고

Claude Code SDK는 각 에이전트를 `--dangerously-skip-permissions`로 실행하는데,
Claude Code는 **root/sudo에서 이 플래그를 거부**합니다. auto-dev를 root로 실행하면
모든 SDK 호출(모델 조회·에이전트 실행·완성)이 `Claude Code process exited with code 1`로
실패합니다. 일반 유저로 실행하세요.

서버는 `npm run serve:user`(→ `scripts/serve.sh`)가 root 감지 시 비-root 유저
(`AUTO_DEV_RUN_AS_USER`, 기본 `shin`)로 권한을 낮춰 실행합니다. 해당 유저는 자체 Claude
자격증명(`~/.claude/.credentials.json`)이 필요합니다. 샌드박스 컨테이너에서는
`IS_SANDBOX=1`을 설정합니다.

SSH 종료 후에도 서버를 유지하려면 user service를 설치합니다.

`./run serve`를 SSH 터미널의 foreground에서 실행하면 터미널 종료 시 서버와 실행 중인
스펙도 함께 종료될 수 있습니다. `npm run service:install`은 현재 프로젝트 절대 경로로
`~/.config/systemd/user/auto-dev.service`를 생성하고 enable합니다. 이후
`npm run service:start`로 시작하면 서버와 provider 자식 프로세스가 SSH 세션에서
분리되고, 비정상 종료 시 자동 재시작됩니다.

로그아웃 뒤에도 유지하려면 linger가 필요하며, 설치 스크립트가 필요할 때 `sudo loginctl enable-linger <user>` 명령을 안내합니다. 로그는 `npm run service:logs`로 확인합니다. 같은 포트에서 `./run serve`와 service를 동시에 실행하지 마세요.

대시보드가 시작한 스펙은 HTTP 응답과 분리된 background 작업이므로 브라우저나 SSH
포트 포워딩을 닫아도 service 안에서 계속됩니다. 대상 프로젝트의 `.auto-dev/project.json`에
`workflow.resumeOnRestart: true`를 설정하면 체크포인트 복구를 opt-in할 수 있습니다.
로컬 체크포인트 실행은 시작 시 Git 작업 트리가 깨끗해야 합니다. 완료된 에이전트 결과는 재시작 뒤 재사용하고,
중단된 읽기 전용 에이전트는 시작 전 파일 해시와 Git HEAD가 그대로일 때만 재실행합니다.
파일 쓰기 권한이 있는 에이전트, 동적 팀,
verify, runtime, 성공 후 전달 작업 도중 중단되거나 파일 변경이 모호하면
`RECOVERY_REQUIRED`로 멈추고 작업 파일은 보존합니다. 설정이 없으면 기존처럼
`server_restart` 실패 처리됩니다.

GitHub PR 전달은 대상 프로젝트의 `.auto-dev/project.json`에
`delivery.mode: "pull-request"`를 설정합니다. 에이전트를 시작하기 전에 GitHub `origin`,
`gh` 인증, HTTPS 대시보드 주소를 확인하고 `data/worktrees/<workflowRunId>`의 전용
`autodev/<runId>` 브랜치에서 원격 기본 브랜치 또는 지정한 base로 작업합니다. 리뷰와
설정된 검증이 통과하면 오케스트레이터가 commit, 일반 push, PR 생성 또는 기존 PR 재사용을
수행합니다. commit/push/PR 도중 재시작하면 로컬 및 GitHub 상태를 확인해 이어갑니다.
외부 전달만 실패한 경우 검증된 worktree와 함께 `DELIVERY_PENDING`으로 남으며 대시보드에서
재시도할 수 있습니다.

```json
{
  "version": 1,
  "verify": { "command": "npm test" },
  "delivery": { "mode": "pull-request", "baseBranch": "main" }
}
```

PR 전달에는 `AUTO_DEV_PUBLIC_BASE_URL`과
`AUTO_DEV_PUBLIC_ACCESS_CONTROL=authenticated` 또는 `network-restricted`가 필요합니다.
이 값은 외부 HTTPS 프록시가 대시보드와 **모든 API 경로**(실행·증거 API 포함)를 보호한다는
운영자 확인값일 뿐, 자체 인증을 추가하지 않습니다. 접근 제어가 실제로 적용된 뒤에만 설정하세요.
서버 기본 바인드 주소는 계속 `127.0.0.1`입니다. 이 모드에서 CLI와 `POST /api/specs`도
체크포인트 세션을 사용합니다. 이슈 트래커에서 시작한 워크플로우는 PR 모드에서 에이전트를
시작하기 전에 중단됩니다. 대시보드나 CLI에서 실행하세요.

### 자동 머지 자격 평가와 요청

PR workflow는 `"delivery": { "autoMerge": { "enabled": true } }`로 자동 머지 자격을
읽기 전용으로 평가할 수 있습니다. 평가 통과 뒤 GitHub 자동 머지 요청까지 허용하려면 대상
프로젝트에 `"requestMerge": true`를 별도로 설정해야 합니다. 대시보드의 전역 비상 스위치도
기본 비활성입니다. 실제 요청에는 `AUTO_DEV_AUTO_MERGE_ENABLED=true`와 정확한
`AUTO_DEV_AUTO_MERGE_REPOSITORIES=owner/repo` allowlist 항목이 필요합니다. 각 게이트는
독립적이며 프로젝트 설정은 workflow 시작 시 기준 checkout에서 읽어야 합니다. 두 설정 모두
`delivery.mode: "pull-request"`에서만 유효합니다.

자격에는 정확한 저위험 diff, 변경되지 않은 정책 fingerprint, 저장된 결정적 검증 증거,
성공한 review, 현재 head에 대한 사람의 승인, 보호 규칙과 필수 체크 통과, 서로 다른 케이스
10개 이상에 걸친 연속 eval 20회, 그리고 사람의 승인을 받고 사람 계정이 병합한 PR 10개가
각각 14일 동안 안정된 기록이 필요합니다. 현재 eval 케이스는 아직 이 기준을 제공하지 않아
matching eval 기록이 쌓이기 전까지 자격이 없습니다. 실사용 기록은 14일이 지난 뒤 사람이
`auto-dev/merge-stable` 라벨을 붙여 확인합니다. `auto-dev/merge-reverted`,
`auto-dev/merge-hotfix`, `auto-dev/merge-rework` 라벨은 streak를 초기화합니다. GitHub 이력이
불완전하거나 확인할 수 없으면 자격을 거부합니다. 요청 직전에 평가 전체와 PR head를 다시
확인하고 `--match-head-commit`에 평가된 SHA를 전달합니다. `gh pr merge --auto`는 GitHub에
해당 head를 조건 충족 시 병합해 달라고 요청하며 branch protection을 우회하거나 즉시 직접
merge하지 않습니다. append-only action 로그와 PR head별
요청 claim으로 재시작·재시도 중복을 막습니다. 대시보드 스위치는 새 요청을 즉시 차단하고,
환경 변수는 서버 기능의 상한을 제어합니다.

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

## 저장소 품질 게이트

Pull request와 `master` push에서 LLM 호출 없이 동일한 검사를 실행한다:
`npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run arch`, `npm run size-budget`.

저장소의 `.auto-dev/project.json`은 자체 작업에 기준선 검증과 PR 전달을 적용한다.
자동 머지는 켜지지 않는다. 프로젝트 맥락과 로컬 서버 실행 방법은
`.auto-dev/feature-map.md`에 있다.

## 스펙 워크플로우

`./run spec <file>`은 아래 순서로 전체 파이프라인을 실행합니다:

```
clarifier → planner → scaffold → test → review → cicd
```

`clarifier`가 요구사항이 아직 구현 가능한 수준이 아니라고 판단하면 planner/scaffold로 넘어가지 않고 추천 답안을 포함한 질문을 반환한 뒤 멈춥니다. 대시보드에서는 그 질문에 바로 답하면 **스펙을 다시 입력하지 않고** 재개됩니다 — 답변이 원본 스펙과 합쳐져 연결된 새 run으로 진행되며, clarifier가 또 물으면 반복됩니다. 각 spec 세션은 `<project>/docs/plan/<slug>.md`에 plan 문서(원본 스펙 + 의사결정 히스토리 + planner 산출물)를 누적 기록합니다. 리뷰 단계에서 `[VERDICT: SHIP]` 마커가 확인되면 파이프라인이 조기 종료됩니다. 마지막 `cicd` 단계는 planner가 명시적인 CI/CD 작업을 할당할 때만 실행되며, 기본은 CI이고 배포 요청이 명시된 경우에만 CD 산출물을 만듭니다. `--steps`로 실행할 단계를 지정하거나, `--iterations`로 review/test 재작업 라우팅 상한(기본 4, 최대 10)을 설정할 수 있습니다.

활성 workflow 단계가 성공적으로 끝나면 내부 후처리 에이전트 두 개가 고정 순서로 백그라운드 실행됩니다. `checking-docs-before-commit`이 오래된 문서를 점검·갱신한 뒤, `atomic-commit`이 해당 spec에 속한 파일 또는 hunk만 stage하고 검증된 atomic commit을 생성합니다. 전역 스킬 지침은 `~/.codex/skills`, 이어서 `~/.claude/skills`에서 읽으며 `AUTO_DEV_SKILLS_ROOT`로 루트를 덮어쓸 수 있습니다. clarifier 응답 대기, 실패·취소, 안전 상한으로 미완료된 workflow는 커밋하지 않습니다. 후처리 실행은 spec workflow와 분리되며 spec 완료 상태를 바꾸지 않고, 실패는 별도 로그로 기록합니다.

### auto-dev 자체 평가

`./run eval`은 `evals/cases/<case-id>/`의 모든 fixture를 실행합니다. `--case <id>`로 하나를 고르고 `--models id1,id2`로 모델 매트릭스를 비교할 수 있습니다. 각 케이스는 `spec.md`, `fixture/`, `checks.sh`, `meta.json`으로 구성되고 선택적으로 `oracle/`을 둘 수 있습니다. 임시 Git 기준선을 만든 뒤 `checks.sh`를 에이전트 workspace 밖에 두고 `triggerSource: eval`로 `runSpec`을 실행합니다. workflow가 끝난 뒤 `oracle/` 파일을 덮어써 채점에 사용합니다. `REJECT`는 integrity 위반이 없고 verdict가 `SHIP`이 아닌 경우에 통과합니다. 결과에는 라우트 수, 토큰, 시간, 오라클 적용 여부, 무결성 위반, 검증 출력과 직전 실행 대비 결과가 `data/evals/<timestamp>.json`에 기록됩니다. 모델 오버라이드는 해당 비동기 workflow에만 적용되어 저장 설정을 바꾸지 않습니다. `meta.json`의 `autoMergeCategory`에 `docs` 또는 `dependency-patch`를 지정하면 해당 분류의 자동 머지 eval streak에 반영됩니다. 분류가 없는 일반 케이스는 streak에 포함되지 않습니다. eval은 성공 후 자동 커밋을 예약하지 않습니다. Spring/PostgreSQL 케이스는 Maven, Docker Compose, 의존성 다운로드가 필요하고 TypeScript 케이스는 Node.js 24가 필요합니다.

### 결정적 검증 게이트

대상 프로젝트가 `<project>/.auto-dev/project.json`에 검증 방법을 선언하면, test 단계의 `[TESTS: PASS]`를 그대로 믿지 않고 **오케스트레이터가 그 명령을 직접 실행해 종료 코드로 통과를 확정**합니다.

```json
{
  "version": 1,
  "verify": {
    "command": "./gradlew check",
    "timeoutMs": 900000,
    "baseline": true,
    "report": { "format": "junit-xml", "paths": ["build/test-results/test/*.xml"] }
  },
  "runtime": {
    "up": "docker compose up -d --wait",
    "down": "docker compose down -v",
    "healthcheck": { "url": "http://localhost:8080/actuator/health", "timeoutMs": 120000 },
    "checks": [".auto-dev/checks/smoke.sh"]
  },
  "roleBoundary": {
    "testGlobs": ["src/test/**", "**/*.test.ts"],
    "ignoreGlobs": []
  },
  "protect": { "globs": [".github/**"] }
}
```

- `verify.command`가 0이 아닌 코드로 끝나거나 타임아웃되면 PASS 마커를 무시하고, 출력 꼬리를 피드백으로 붙여 planner로 되돌립니다. 재작업 예산이 소진되면 `verify_failed`로 실패합니다.
- 결과는 `agent_name='verify'` 실행 기록으로 남아 대시보드의 워크플로 상세에서 종료 코드 요약·소요 시간·출력 꼬리를 볼 수 있습니다. 대시보드에서 취소하면 프로세스 그룹 전체가 정리됩니다.
- 기본 테스트 glob과 `.auto-dev/project.json`, `.auto-dev/checks/**`, `.auto-dev/rules.json` 보호는 설정 파일 없이도 적용됩니다. `protect.globs`는 경로를 추가하며 기본 보호 경로를 제거할 수 없습니다. skip/focus 마커, 테스트 파일 삭제, JUnit 테스트 수 약화는 `integrity` finding으로 기록하고 planner로 라우팅합니다. 무결성 검사를 위해 Git 작업 트리가 필요하며, 없으면 `integrity_unavailable`로 `BLOCKED` 처리합니다.
- `verify.baseline: true`는 planner 전에 verify를 실행해 기준선이 실패하면 `baseline_red`로 중단합니다. `verify.report`는 최신 JUnit 리포트의 `tests`, `skipped`, `failures`, `errors`를 기준선과 비교합니다. 오래된 리포트는 경고 후 비교를 생략하고, report 설정에는 `baseline: true`가 필요합니다.
- `roleBoundary.testGlobs`를 선언하면 test 단계 전후의 파일 내용 해시를 비교해, 테스트 경로 밖의 파일을 수정한 경우 `role_boundary_violation`으로 실패시킵니다 (되돌리지 않고 보고만 합니다).
- 이 파일이 없으면 프로젝트 설정 verify/runtime 게이트는 비활성이고 기본 무결성 보호만 동작합니다. 의도적으로 테스트를 줄일 때는 `./run spec request.md --allow-test-regression` 또는 대시보드 체크박스를 사용합니다. 실행 이벤트와 PR 본문에 남으며 보호 경로 검사는 계속 적용됩니다. 파일이 있는데 스키마가 틀리면 run이 즉시 실패합니다.

대시보드 실행은 `"workflow": { "resumeOnRestart": true }`로 재시작 체크포인트를 별도
opt-in할 수 있습니다. 시작 시 Git 작업 트리가 깨끗해야 합니다. 완료된 결과는 재사용하고
변경되지 않은 읽기 전용 단계는 재실행합니다. 쓰기 단계/동적 팀/verify/runtime/전달 중단이나 워크스페이스 변경은 대시보드에
`RECOVERY_REQUIRED`로 표시합니다. 현재 범위와 한계는 위 운영 안내를 참고하세요.

`runtime`을 설정하면 `[TESTS: PASS]` 뒤에 `verify` 명령, 런타임 기동, HTTP healthcheck, 결정적 스크립트, 새 verifier 세션 순서로 실행한 뒤 review로 진행합니다. 기동·healthcheck·check·동작 검증이 실패하면 증거를 붙여 planner로 되돌립니다. 취소를 포함한 모든 경로에서 `finally`가 runtime `down`을 실행합니다. 오케스트레이터는 런타임 명령과 verifier 도구에 `COMPOSE_PROJECT_NAME=autodev-<workflow ID 앞부분>`을 전달합니다.

런타임 관찰 결과는 `data/evidence/<workflowRunId>/evidence.json`에 저장합니다. workflow 상세 화면과 `GET /api/runs/:id/evidence`에서 요청·응답 요약, 명령 출력 꼬리, verifier 보고서를 볼 수 있습니다. Compose 프로젝트 이름은 컨테이너 자원을 분리하지만 호스트 포트는 공유되므로 프로젝트별 변수로 지정해야 합니다. 예: `ports: ["${WEB_PORT:-8080}:8080"]`.

내부 `verifier`는 새 실행에서 `Read`, `Bash`를 받고 feature map을 참고합니다. 실제 동작을 확인한 뒤 `[VERIFY: PASS]`, `[VERIFY: FAIL]`, `[VERIFY: BLOCKED]` 중 하나를 보고합니다. verifier의 Bash가 workspace를 수정하면 실행 전후 스냅샷으로 감지해 되돌리지 않고 실패 처리합니다.

### 버그 이슈: 수정 전에 재현

이슈 타입이 정확히 `BUG`이면 대소문자와 앞뒤 공백을 무시하고 재현 모드로 실행합니다. test 에이전트는 테스트 파일만 작성하고 `[REPRO: <command>]`를 반환합니다. 오케스트레이터는 이 명령을 프로젝트 디렉터리에서 실행한 뒤에만 이슈를 `IN_PROGRESS`로 바꿉니다. 명령이 통과하면 이미 해결됐거나 정보가 부족한 것으로 보고 `BLOCKED`, `cause: not_reproduced`로 종료하며 이슈 상태는 유지합니다.

재현 실패를 관찰한 뒤 planner/scaffold 수정 루프를 시작합니다. 수정 후 같은 명령이 통과해야 하며, 이후 설정된 verify/runtime 게이트와 review를 진행합니다. 그 외 이슈 타입은 기존 SpecWorkflow를 따릅니다.

### 리뷰 지적과 규칙화 후보

review 프롬프트는 기존 verdict 마커 앞에 `FINDINGS_JSON` 블록을 출력합니다. 유효한 지적은 `review_finding`에 저장하고, 블록이 없거나 파싱에 실패하면 run은 계속 진행하며 경고 이벤트만 남깁니다. verify 실패와 역할 경계 위반도 같은 테이블에 기록합니다. 일일 브리핑과 대시보드는 최근 14일 `category + rule_hint` 빈도를 프로젝트별로 보여줍니다. 후보는 사람이 검토한 뒤 대상 저장소의 `AGENTS.md` 또는 테스트·정적 분석 하드 규칙으로 승격합니다.

### 대상 프로젝트 컨텍스트

대상 저장소에 있는 지식을 에이전트 입력에 반영합니다.

- `AGENTS.md`가 프로젝트 작업 규칙을 제공합니다. 파일이 없으면 Anthropic 실행은 Claude Agent SDK가 이미 읽는 `CLAUDE.md`를 사용하고, 다른 provider는 프롬프트에 직접 넣습니다.
- `.auto-dev/feature-map.md`에는 서비스 실행, 엔드포인트 요청, 데이터 확인, 패키지 의존 규칙을 적습니다.
- planner, scaffold, test, review에는 두 자료를 넣고, clarifier와 runtime verifier에 auto-dev가 추가하는 context 절에는 feature map만 넣습니다. review 렌즈도 review와 같은 컨텍스트를 받습니다.
- 전체 컨텍스트는 16 KiB로 제한하며, 넘으면 잘림 표시와 함께 자릅니다. 파일이 없으면 건너뜁니다.
- Anthropic SDK는 기본 동작으로 clarifier에도 `CLAUDE.md`를 읽을 수 있으며, auto-dev는 이를 프롬프트에 중복 삽입하지 않습니다.

작성 예시는 [`docs/templates/feature-map.md`](docs/templates/feature-map.md)를 참고하세요.

## 대시보드

`./run serve`로 HTTP 서버를 시작합니다 (기본값: `http://127.0.0.1:8080`).

- 에이전트 현황 및 일일 실행 횟수
- Claude Code 브라우저 OAuth 로그인, fallback 모델 재시도, 표준화된 실패 상태
- 실행 목록과 상태의 실시간 갱신, 소요시간·토큰 사용량·마크다운 출력·취소
- 스펙 재입력 없이 clarifier 답변, 후속 지시, 특정 단계부터 재개
- 단계별 agent/workflow 제출 및 프로젝트·모델·effort·재작업 상한 설정
- 텍스트 요청과 참고 context 파일을 함께 제출하는 spec 입력 (모든 확장자, 파일당 2MB·전체 10MB, 여러 파일; 바이너리는 경로로 전달)
- workflow 상세, agent 이동, 실패 원인, 토큰 breakdown
- healthcheck 응답, check 출력, verifier 보고서 등 런타임 검증 증거
- 일반 질문과 읽기 전용 프로젝트 Q&A를 지원하는 AI 채팅; 기록은 브라우저 `localStorage`에만 저장
- 프로젝트 문맥은 README와 프로젝트 내부의 안전한 텍스트 파일로 제한

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
| `POST` | `/api/chat` | NDJSON 스트리밍 채팅 — 선택 모델, 최근 대화, 관련 브라우저 기억, 선택적 읽기 전용 프로젝트 문맥 |
| `POST` | `/api/chat/memory` | 클라이언트가 보낸 대화를 주제별 Markdown 장기 기억으로 압축; 서버 저장 없음 |
| `GET` | `/api/runs` | 최근 실행 목록 (`?units=` 최상위 유닛, `{ rows, hasMore }` 반환) |
| `GET` | `/api/runs/:id` | 단일 실행 상세 |
| `GET` | `/api/runs/:id/checkpoint` | opt-in workflow 재시작 복구 상태 |
| `POST` | `/api/runs/:id/delivery/retry` | 대기 중인 체크포인트 PR 전달 재시도 |
| `GET` | `/api/runs/:id/evidence` | 런타임 검증 요청·응답·출력·verifier 증거 |
| `POST` | `/api/runs/:id/cancel` | 실행 중인 워크플로우 또는 에이전트 프로세스 강제 중단 |
| `GET` | `/api/runs/:id/clarification` | 멈춘 spec run 의 대기 중 clarifier 질문 |
| `POST` | `/api/runs/:id/answers` | `{ answers }` 로 spec 워크플로우 재개 (스펙 재입력 불필요) |
| `POST` | `/api/runs/:id/continue` | `{ instruction }` 로 완료된 spec run 이어가기 (스펙 재입력 불필요) |
| `POST` | `/api/runs/:id/resume-last` | 마지막으로 실행된 워크플로우 단계부터 재개 |
| `GET` | `/api/runs/:id/events` | SSE — 실행 중 라이브 이벤트 |
| `GET` | `/api/runs/:id/events/history` | 실행 이력에 저장된 이벤트 기록 |
| `GET` | `/api/review-findings/candidates` | 최근 14일 리뷰·검증 규칙화 후보를 프로젝트별로 조회 |
| `GET` | `/api/stats` | 에이전트 · 상태별 집계 통계 |
| `GET`/`POST` | `/api/config` | 모델·에이전트 설정, 전역 자동 머지 스위치, 프로젝트 목록 조회·변경 |
| `GET` | `/api/issues` · `POST /api/issues/:key/run` | issue-tracker 조회 + 자동 처리 |

## 설정

설정은 대시보드의 설정 패널에서 변경할 수 있습니다. Codex CLI 모델 선택지는 로그인된 계정의 현재 모델 카탈로그에서 가져옵니다. 조회에 실패하면 확인되지 않은 Codex 모델을 숨기며, 저장값이나 정적 폴백을 목록에 다시 추가하지 않습니다. 런타임 변경값은 `AUTO_DEV_CONFIG_PATH`(기본 `./data/config.json`)에 저장되며 환경 변수보다 우선합니다. 환경 변수는 초기 부트스트랩 설정으로 계속 사용할 수 있습니다:

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `AUTO_DEV_ENV_FILE` | `.env` | 프로세스 시작 시 읽을 환경 파일. 파일 내부가 아니라 셸/systemd에서 지정 |
| `AUTO_DEV_PROVIDER` | `anthropic` | LLM 프로바이더 선택 (`anthropic` 또는 `codex-cli`) |
| `AUTO_DEV_MODEL` | (프로바이더 기본) | 사용할 프로바이더 모델 |
| `AUTO_DEV_AGENT_<AGENT>_MODEL` | 미설정 | 에이전트별 모델 override. 예: `AUTO_DEV_AGENT_SCAFFOLD_MODEL` |
| `AUTO_DEV_FALLBACK_MODEL` | 미설정 | 선택한 전역/에이전트별 모델을 사용할 수 없을 때 쓸 폴백 모델 |
| `AUTO_DEV_EFFORT` | `high` | effort 레벨 (`low`~`max`; Codex는 현재 `low`/`medium`/`high` 노출) |
| `AUTO_DEV_CONFIG_PATH` | `./data/config.json` | 대시보드에서 저장한 런타임 설정 파일 |
| `AUTO_DEV_AUTO_MERGE_ENABLED` | `false` | Phase 7D 자동 머지 요청의 서버 기능 상한 |
| `AUTO_DEV_AUTO_MERGE_REPOSITORIES` | 비어 있음 | 요청을 허용할 정확한 `owner/repo` 목록 (쉼표 구분) |
| `AUTO_DEV_CODEX_COMMAND` | `codex` | `AUTO_DEV_PROVIDER=codex-cli`일 때 사용할 Codex CLI 명령 |
| `AUTO_DEV_CODEX_TIMEOUT_MS` | `600000` | Codex CLI 실행 timeout |
| `AUTO_DEV_CODEX_SANDBOX` | CLI 기본값 | 선택적 Codex 샌드박스 모드 (예: `workspace-write`) |
| `AUTO_DEV_CODEX_BYPASS_SANDBOX` | 미설정 | `1`이면 Codex 승인·샌드박스 검사를 우회. 격리된 신뢰 환경에서만 사용 |
| `AUTO_DEV_CLAUDE_COMMAND` | `claude` | 대시보드 인증 상태 확인에 사용할 Claude CLI 명령 |
| `CLAUDE_CODE_VERSION` | `2.1.274` | Docker 이미지에 설치할 Claude Code CLI 버전 |
| `AUTO_DEV_WORKSPACE_ROOT` | `./data/workspace` | 프로젝트명 해석 기준 루트 |
| `AUTO_DEV_SKILLS_ROOT` | `~/.codex/skills`, 이후 `~/.claude/skills` | 성공한 spec의 커밋 후처리에 사용할 전역 스킬 루트 override |
| `AUTO_DEV_RUN_AS_USER` | `shin` | root로 시작 시 `scripts/serve.sh`가 권한을 낮출 비-root 유저 |
| `AUTO_DEV_DB_PATH` | `./data/auto-dev.db` | SQLite 데이터베이스 경로 |
| `AUTO_DEV_BIND_ADDR` | `127.0.0.1` | HTTP 서버 바인드 주소 |
| `AUTO_DEV_BIND_PORT` | `8080` | HTTP 서버 포트 |
| `AUTO_DEV_PUBLIC_BASE_URL` | 미설정 | PR 링크에 사용할 HTTPS 대시보드 URL |
| `AUTO_DEV_PUBLIC_ACCESS_CONTROL` | 미설정 | 외부 프록시의 전체 대시보드/API 접근 제어 확인값 (`authenticated` 또는 `network-restricted`) |
| `AUTO_DEV_DAILY_RUN_LIMIT` | `100` | 일일 실행 횟수 한도 (비우면 무제한) |
| `AUTO_DEV_CIRCUIT_BREAKER_FALLBACK_MS` | `300000` | rate-limit reset 시각이 없을 때 회로 차단 대기 시간(ms) |
| `AUTO_DEV_HOST_PORT` | `8080` | Docker Compose가 공개하는 호스트 포트 |
| `AUTO_DEV_BACKUP_DIR` | `./data/backups` | `npm run backup:db` 백업 출력 디렉터리 |
| `AUTO_DEV_OPENCLAW_ENABLED` | `false` | OpenClaw Telegram 완료/실패 알림 활성 |
| `AUTO_DEV_OPENCLAW_ACCOUNT` | `main` | 알림에 사용할 OpenClaw Telegram 계정 |
| `AUTO_DEV_OPENCLAW_COMMAND` | `openclaw` | OpenClaw CLI 명령 또는 절대 경로 |
| `AUTO_DEV_OPENCLAW_CONFIG_PATH` | `~/.openclaw/openclaw.json` | 대상 allowlist를 읽을 OpenClaw 설정 |
| `AUTO_DEV_OPENCLAW_TARGET` | 계정 `allowFrom[0]` | 명시적 Telegram chat ID override |
| `AUTO_DEV_OPENCLAW_API_TOKEN` | 미설정 | 루프백 bridge 선택적 Bearer 토큰 |
| `AUTO_DEV_ISSUE_TRACKER_URL` | (없음) | issue-tracker URL — 설정 시 연동 활성 |
| `AUTO_DEV_ISSUE_TRACKER_STATUS` | `OPEN` | issue-tracker 조회 대상 상태 필터 |
| `AUTO_DEV_WORKLOG_BRIEFING_ENABLED` | `false` | 일일 리뷰 브리핑 스케줄러 활성화 |
| `AUTO_DEV_WORKLOG_BRIEFING_CRON` | `0 9 * * *` | 브리핑 스케줄 크론 표현식 |
| `AUTO_DEV_WORKLOG_PATH` | `./data/worklog.md` | 일일 브리핑이 읽을 워크로그 파일 경로 |

## 프로젝트 구조

```
auto-dev-ts/
├── prompts/          각 에이전트 시스템 프롬프트 (Markdown)
├── evals/            고정 평가 케이스와 대상 프로젝트 fixture
├── deploy/systemd/   SSH와 독립된 user service 템플릿
├── integrations/     OpenClaw workspace skill + deterministic bridge script
├── scripts/          운영 스크립트 (비-root 런처 + user service 설치)
├── .github/          PR 및 master 품질 검사 workflow
├── .auto-dev/        자체 검증·전달 설정과 feature map
├── eslint.config.js  오케스트레이션 안전성 타입 검사 규칙
├── .dependency-cruiser.cjs  소스 의존 방향 검사
├── size-budget.json  대형 소스 파일 증가 기준선
├── static/           대시보드 + 플로팅 채팅 위젯 (바닐라 HTML/CSS/JS)
├── src/
│   ├── agents/       에이전트 구현체 및 레지스트리
│   │   └── review/   멀티 렌즈 리뷰 오케스트레이터 + 렌즈 정의
│   ├── workflows/    SpecWorkflow + 검증 게이트 + 이슈·eval 워크플로우
│   ├── llm/          LLM 프로바이더 seam (registry + anthropic/codex 구현)
│   ├── integrations/ issue-tracker 클라이언트 + OpenClaw Telegram 알림
│   ├── store/        SQLite 스키마 + CRUD
│   ├── lib/          러너, 가드, 회로차단기, SSE, 워크스페이스 해석,
│   │                 프로젝트 설정·검증 실행·역할 경계 검사 등
│   ├── server/       Hono HTTP 서버 + 라우트
│   ├── schedule/     node-cron 일일 브리핑
│   └── cli.ts        Commander CLI 진입점
├── .env.example
├── package.json
└── tsconfig.json
```

## 라이선스

MIT
