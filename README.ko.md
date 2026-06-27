# auto-dev

[Claude Code SDK](https://github.com/anthropics/claude-agent-sdk-typescript) 기반 개발 자동화 에이전트. 스캐폴딩, 코드 리뷰, 테스트, CI/CD, 플래닝, 스펙 정제를 담당하는 6개의 전문 AI 에이전트를 오케스트레이션합니다. LLM API 키나 토큰 비용 없이 동작합니다.

> [English documentation](README.md)

## 동작 방식

클라우드 LLM API를 직접 호출하는 대신, Agent SDK를 통해 **Claude Code** CLI를 프로그래밍으로 제어합니다. 각 에이전트는 워크스페이스 디렉토리로 파일 I/O와 쉘 접근이 제한된 Claude Code 세션 안에서 실행됩니다. 리뷰 에이전트는 정확성 · 보안 · 성능 · 스타일 4개 서브에이전트를 동시에 병렬 실행합니다.

모든 실행 기록은 로컬 SQLite 데이터베이스에 저장되며, 내장 웹 대시보드에서 확인할 수 있습니다.

## 에이전트

| 에이전트 | 설명 |
|---------|------|
| `scaffold` | 스펙 또는 설명에서 코드 스켈레톤 생성 |
| `review` | 멀티 렌즈 코드 리뷰: 정확성 · 보안 · 성능 · 스타일 (병렬) |
| `test` | 기존 코드에 대한 테스트 케이스 생성 |
| `cicd` | CI/CD 파이프라인 설정 생성 (GitHub Actions 등) |
| `planner` | 스펙에서 구조화된 개발 계획 수립 |
| `clarifier` | 플래닝 전 스펙의 불명확한 점 파악 |

## 요구사항

- [Claude Code](https://claude.ai/code) 설치 및 인증 완료 (`claude`가 PATH에 있어야 함)
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
./run cicd "Node.js 모노레포, AWS ECS 배포"
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

## 스펙 워크플로우

`./run spec <file>`은 아래 순서로 전체 파이프라인을 실행합니다:

```
clarifier → planner → scaffold → test → review → cicd
```

리뷰 단계에서 `[VERDICT: SHIP]` 마커가 확인되면 파이프라인이 조기 종료됩니다. `--steps`로 실행할 단계를 지정하거나, `--iterations`로 scaffold→review 루프를 반복할 수 있습니다.

## 대시보드

`./run serve`로 HTTP 서버를 시작합니다 (기본값: `http://127.0.0.1:8080`).

- 에이전트 현황 및 일일 실행 횟수
- 최근 실행 목록 (에이전트, 상태, 소요시간, 출력 미리보기) — 10초마다 자동 갱신
- 실행 중인 작업은 SSE로 라이브 갱신, 행 클릭 시 상세 패널 펼치기
- 에이전트 출력은 마크다운으로 렌더링(살균 처리), 렌더/원본 토글 제공
- 작업 제출: 에이전트 선택 + 프로젝트 드롭다운(워크스페이스 프로젝트) + 모델/effort 설정

원격 서버에 SSH로 접속 중이라면 로컬 포트 포워딩을 사용합니다:

```bash
ssh -L 8080:127.0.0.1:8080 user@host -N
```

## REST API

| 메서드 | 경로 | 설명 |
|--------|------|------|
| `GET` | `/api/status` | 에이전트 목록 + 실행 가드 + 회로차단기 통계 |
| `POST` | `/api/agents/:name` | 단일 에이전트 실행 (`project` 지정 가능) |
| `POST` | `/api/clarify` | Q&A 컨텍스트와 함께 clarifier 실행 |
| `POST` | `/api/specs` | 스펙 워크플로우 실행 |
| `POST` | `/api/llm/complete` | 단발성 LLM 생성 프록시 (외부 앱이 구독으로 호출) |
| `GET` | `/api/runs` | 최근 실행 목록 (`?limit=`) |
| `GET` | `/api/runs/:id` | 단일 실행 상세 |
| `GET` | `/api/runs/:id/events` | SSE — 실행 중 라이브 이벤트 |
| `GET` | `/api/stats` | 에이전트 · 상태별 집계 통계 |
| `GET`/`POST` | `/api/config` | 모델/effort 조회·변경 + 프로젝트 목록 |
| `GET` | `/api/issues` · `POST /api/issues/:key/run` | issue-tracker 조회 + 자동 처리 |

## 설정

모든 설정은 환경 변수로 관리합니다 (`.env.example`을 `.env`로 복사):

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `AUTO_DEV_PROVIDER` | `anthropic` | LLM 프로바이더 선택 |
| `AUTO_DEV_MODEL` | (CLI 기본) | 사용할 Claude 모델 |
| `AUTO_DEV_EFFORT` | `high` | effort 레벨 (`low`~`max`) |
| `AUTO_DEV_WORKSPACE_ROOT` | `./data/workspace` | 프로젝트명 해석 기준 루트 |
| `AUTO_DEV_RUN_AS_USER` | `shin` | root로 시작 시 `scripts/serve.sh`가 권한을 낮출 비-root 유저 |
| `AUTO_DEV_DB_PATH` | `./data/auto-dev.db` | SQLite 데이터베이스 경로 |
| `AUTO_DEV_BIND_ADDR` | `127.0.0.1` | HTTP 서버 바인드 주소 |
| `AUTO_DEV_BIND_PORT` | `8080` | HTTP 서버 포트 |
| `AUTO_DEV_DAILY_RUN_LIMIT` | `100` | 일일 실행 횟수 한도 (비우면 무제한) |
| `AUTO_DEV_ISSUE_TRACKER_URL` | (없음) | issue-tracker URL — 설정 시 연동 활성 |
| `AUTO_DEV_WORKLOG_BRIEFING_ENABLED` | `false` | 일일 리뷰 브리핑 스케줄러 활성화 |
| `AUTO_DEV_WORKLOG_BRIEFING_CRON` | `0 9 * * *` | 브리핑 스케줄 크론 표현식 |

## 프로젝트 구조

```
auto-dev-ts/
├── prompts/          각 에이전트 시스템 프롬프트 (Markdown)
├── scripts/          운영 스크립트 (serve.sh — 비-root 서버 런처)
├── static/           대시보드 프론트엔드 (바닐라 HTML/JS)
├── src/
│   ├── agents/       에이전트 구현체 및 레지스트리
│   │   └── review/   멀티 렌즈 리뷰 오케스트레이터 + 렌즈 정의
│   ├── workflows/    SpecWorkflow + 이슈 기반 워크플로우
│   ├── llm/          LLM 프로바이더 seam (registry + anthropic 구현)
│   ├── integrations/ issue-tracker 클라이언트
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
