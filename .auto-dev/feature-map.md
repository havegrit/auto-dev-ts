# auto-dev-ts feature map

> auto-dev 에이전트가 이 저장소를 수정하고 결과를 검증할 때 참고한다.

## 서비스 실행과 종료

개발 서버는 별도 터미널에서 임시 DB, 런타임 설정, 워크스페이스, 포트를 지정해 실행한다.

```bash
tmp_dir="$(mktemp -d)"
mkdir -p "$tmp_dir/workspace"
AUTO_DEV_DB_PATH="$tmp_dir/auto-dev.db" \
AUTO_DEV_CONFIG_PATH="$tmp_dir/config.json" \
AUTO_DEV_WORKSPACE_ROOT="$tmp_dir/workspace" \
AUTO_DEV_BIND_PORT=18080 \
  ./run serve
```

서버는 기본적으로 `127.0.0.1`에 바인딩한다. 종료는 실행 터미널에서 `Ctrl-C`를 누른다.

## 주요 엔드포인트

| 기능 | 메서드와 경로 | 비고 |
|---|---|---|
| 상태 확인 | `GET /api/status` | 에이전트, 실행 가드, 회로차단기 상태 |
| 최근 실행 | `GET /api/runs?units=5` | 최근 최상위 실행과 페이지 상태 |

```bash
curl -fsS http://127.0.0.1:18080/api/status
curl -fsS 'http://127.0.0.1:18080/api/runs?units=5'
```

## 데이터 확인

이 서버는 SQLite를 사용하고 Kafka는 사용하지 않는다. 실행 시 `AUTO_DEV_DB_PATH`로 지정한 DB를 확인한다.

```sql
SELECT id, agent_name, status, started_at, duration_ms
FROM agent_run
ORDER BY started_at DESC
LIMIT 10;

SELECT ts, type, data
FROM agent_run_event
WHERE run_id = '<run-id>'
ORDER BY id;

SELECT workflow_run_id, state, updated_at
FROM workflow_checkpoint
ORDER BY updated_at DESC;
```

## 패키지 구조와 의존 방향

- `src/workflows/`가 실행 흐름을 조정하고 `agents`, `llm`, `store`, `lib`를 사용한다.
- `src/agents/`는 에이전트 실행을 정의하며 workflow나 server를 역참조하지 않는다.
- `src/llm/`은 provider 경계다. `store`, `workflows`, `agents`, `server`에 의존하지 않는다.
- `src/store/`는 SQLite 스키마와 CRUD를 소유하고 상위 계층을 참조하지 않는다.
- `src/lib/`은 공용 기반 계층이며 workflow, server, schedule을 참조하지 않는다.
- 예외는 `src/lib/auto-merge-policy.ts`에서 `src/agents/specs.ts`의 `AGENT_SPECS`를 읽는 정책 참조 하나다.

## 금지 패턴

- 순환 의존, `src/`에서 `console` 직접 사용(cli 진입점 제외), 클래스 선언을 추가하지 않는다.
- Promise 반환 작업을 기다리지 않거나 Promise를 동기 callback 자리에 넘기지 않는다.
- 실제 LLM을 호출하는 테스트를 만들지 않는다. provider와 agent를 mock한다.
- `.github/`, ESLint·의존성 경계·크기 예산 설정, `CLAUDE.md`를 자동 변경하지 않는다. 규칙 완화는 사람 검토 대상으로 별도 처리한다.
