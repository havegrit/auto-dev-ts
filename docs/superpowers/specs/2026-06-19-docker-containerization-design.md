# auto-dev Docker 컨테이너화 설계

- **날짜**: 2026-06-19
- **상태**: 승인됨 (구현 대기)
- **대상 프로젝트**: `auto-dev-ts` — Claude Code SDK 기반 개발 자동화 에이전트

## 배경

`auto-dev`는 클라우드 LLM API를 직접 호출하는 대신 **Claude Code CLI를 Agent SDK로 구동**하는
개발 자동화 도구다. CLI(`./run scaffold|review|test|...`)이면서 동시에 SQLite 백엔드 + Hono
기반 웹 대시보드(`serve`, 8080)를 제공한다.

컨테이너화 시 핵심 제약:

1. `@anthropic-ai/claude-agent-sdk`가 내부적으로 `claude` 실행파일을 spawn → 이미지에 `claude`
   CLI가 PATH에 있어야 함. 인증은 API 키가 아니라 **구독 OAuth**(`~/.claude/.credentials.json`).
2. `better-sqlite3`는 **네이티브 모듈** → 빌드 시 `python3` + C 툴체인 필요, 컨테이너 arch로 컴파일돼야 함.
3. 에이전트가 워크스페이스에서 **파일 I/O + 쉘 작업** 수행 → `git` 필요.
4. SQLite DB(`./data/auto-dev.db`) + workspace 영속화 필요.
5. Node.js ≥ 24 (package.json `engines`).

## 결정 사항 (브레인스토밍 결과)

| 질문 | 결정 | 근거 |
|------|------|------|
| Claude 인증 방식 | 호스트 구독 OAuth 자격증명 재사용 | 프로젝트 철학("API 키·토큰 비용 없음") 유지 |
| 실행 모드 | **dev 우선** (소스 바인드마운트 + `tsx`), prod 타깃 병행 정의 | 컨테이너 안에서 개발 진행 |
| 사용 패턴 | 상시 `serve` 서버 + `docker compose exec`로 CLI | dev 워크플로우에 자연스러움 |
| 자격증명 마운트 권한 | **rw** | access token은 단명 → 컨테이너가 스스로 갱신해 파일에 써야 함. ro는 만료 시 인증 끊김 |
| 자격증명 마운트 대상 | **컨테이너 전용 named volume**(`claude-config`), 호스트에서 1회 시드 | 호스트 config/history와 격리, refresh token 회전 충돌 회피 |
| Claude 버전 | **이미지에 핀, 초기값 `2.1.183`(호스트와 동일)** | config가 격리됐으므로 독립 가능, 재현성 위해 고정. 업그레이드는 의도적 재빌드 |

### 자격증명 설계 상세

`~/.claude/.credentials.json`은 단명 access token + refresh token을 담는다. CLI는 access token
만료 시 refresh token으로 새 토큰을 발급받아 **파일에 다시 쓴다.**

- **ro 마운트는 부적합**: 갱신값을 못 써서 토큰 만료 시 인증이 끊긴다.
- **호스트 디렉토리 직접 공유도 부적합**: 호스트와 컨테이너가 같은 자격증명을 동시에 갱신하면
  refresh token 회전 시 한쪽이 무효화될 수 있고, claude 버전 차이로 config 포맷 마이그레이션
  충돌이 날 수 있다.
- **채택: 컨테이너 전용 `claude-config` named volume(rw) + 호스트에서 1회 시드.** 컨테이너가 자기
  토큰 라이프사이클을 독립적으로 관리한다.

## 아키텍처

### Dockerfile (멀티스테이지)

```
base   ─ node:24-bookworm-slim
         + apt: git, build-essential, python3, ca-certificates
         + npm i -g @anthropic-ai/claude-code@2.1.183   (SDK가 spawn할 CLI, 버전 핀)
  │
  ├─ deps ─ COPY package*.json → npm install
  │         (better-sqlite3 네이티브를 컨테이너 arch로 컴파일)
  │
  ├─ dev  ─ (target) deps 기반. 소스는 런타임 바인드마운트.
  │         CMD: npm run serve   (= tsx src/cli.ts serve)
  │
  └─ build ─ deps + COPY 소스 → npm run build
       └─ prod ─ 런타임 의존성만 + dist/
                 CMD: node dist/cli.js serve
```

### compose.yaml (dev 서비스)

```yaml
services:
  auto-dev:
    build: { context: ., target: dev }
    env_file: .env
    environment:
      AUTO_DEV_BIND_ADDR: 0.0.0.0          # 컨테이너 내부는 0.0.0.0 바인드 필수
      AUTO_DEV_BIND_PORT: 8080
    ports:
      - "127.0.0.1:8080:8080"              # 호스트는 loopback에만 노출
    volumes:
      - ./:/app                             # 소스 바인드마운트 (dev: 무재빌드 반영)
      - auto-dev-node_modules:/app/node_modules   # 컨테이너 컴파일 node_modules 보존
      - claude-config:/root/.claude         # 컨테이너 전용 자격증명 (rw, 시드 1회)
    command: npm run serve

  # prod 서비스 — 지금은 정의만, profiles로 분리
  auto-dev-prod:
    profiles: [prod]
    build: { context: ., target: prod }
    env_file: .env
    environment:
      AUTO_DEV_BIND_ADDR: 0.0.0.0
      AUTO_DEV_BIND_PORT: 8080
    ports:
      - "127.0.0.1:8080:8080"
    volumes:
      - ./data:/app/data                    # prod는 데이터만 영속화
      - claude-config:/root/.claude
    command: node dist/cli.js serve

volumes:
  auto-dev-node_modules:
  claude-config:
```

### 볼륨 설계 근거

- **`auto-dev-node_modules`**: `./:/app` 바인드마운트가 호스트의 node_modules(호스트 arch로 빌드된
  `better-sqlite3`)로 컨테이너 것을 덮어쓰는 것을 막는다. 빈 named volume은 이미지의
  `/app/node_modules`로 초기화돼 컨테이너 arch 네이티브 모듈이 유지된다.
- **`./data` 영속화**: dev는 소스 바인드마운트(`./:/app`)에 포함되므로 별도 볼륨 불필요. prod는
  `./data:/app/data`만 별도 마운트.
- **`claude-config`**: 위 자격증명 설계대로 컨테이너 전용.

### .dockerignore

```
node_modules
dist
data
.git
.env
*.tsbuildinfo
```

## 파일 목록

| 파일 | 내용 |
|------|------|
| `Dockerfile` | 멀티스테이지 (base→deps→dev / build→prod), claude CLI `2.1.183` 핀 |
| `compose.yaml` | dev 서비스 + prod 프로파일 + named volumes |
| `.dockerignore` | 빌드 컨텍스트 제외 목록 |
| `docker/seed-claude.sh` | 호스트 `~/.claude/.credentials.json` → `claude-config` 볼륨 1회 시드 |
| `README` (도커 섹션) | 기동·exec·시드·prod 사용법 |

## 시드 절차 (최초 1회)

```bash
docker compose build
bash docker/seed-claude.sh        # 자격증명을 claude-config 볼륨에 복사
docker compose up -d              # serve 대시보드 기동
```

`seed-claude.sh`는 임시 컨테이너에 named volume을 마운트하고 호스트의
`~/.claude/.credentials.json`(+ 필요 시 `settings.json`)을 `/root/.claude`로 복사한다.

## 일상 사용

```bash
docker compose up -d                                   # 대시보드 기동 (127.0.0.1:8080)
docker compose exec auto-dev ./run scaffold "..."      # 에이전트 CLI 실행
docker compose logs -f auto-dev                        # 로그
docker compose down                                    # 중지
```

## 검증 기준 (완료 조건)

1. `docker compose up -d` 후 `http://127.0.0.1:8080` 대시보드 응답.
2. 컨테이너 내부 `claude --version` = `2.1.183`, `node --version` ≥ 24.
3. `docker compose exec auto-dev ./run clarifier "..."`가 **인증을 통과해** 실제 에이전트 실행
   (Claude OAuth 동작 확인).
4. `better-sqlite3`가 컨테이너 arch로 로드되어 DB 쓰기 성공.
5. 소스 수정 시 `tsx` 반영 확인 (dev 모드 hot-reload 성격 동작).
6. 컨테이너 재시작 후에도 토큰 갱신 동작 (rw + named volume 자가 갱신).

## 범위 밖 (YAGNI)

- issue-tracker 연동(`AUTO_DEV_ISSUE_TRACKER_URL`) — 선택 기능, 기본 비활성.
- 워크로그 브리핑 스케줄러 — 선택 기능.
- prod 서비스의 실제 운영 튜닝(헬스체크·리소스 제한 등) — prod 활성화 시점에 별도 처리.
