# 개발 문서 — auto-dev-ts ↔ issue-tracker 연동 (B 작업)

> 목적: auto-dev-ts가 이슈 트래커에서 할당된 작업을 **자동으로 가져와** 에이전트에 전달하고,
> 더 나아가 이슈를 **SpecWorkflow로 자동 처리한 뒤 결과를 다시 이슈에 기록**하도록 연동한다.
> (자바 버전에 있던 `IssueTrackerHook` 구조를 TS로 복원 + 자체 issue-tracker에 맞게 재설계)

---

## 1. 배경 & 목표

- **현재**: auto-dev-ts는 개발 요청을 사람이 직접 입력(CLI 인자/파일)해야 함.
- **자바 버전**: `IssueTrackerHook`(Jira) + 스케줄러가 할당 이슈를 가져와 브리핑까지 수행. → **TS로 미마이그레이션**.
- **목표**:
  1. (필수) auto-dev-ts가 issue-tracker에서 열린 이슈를 자동 수집 → 일일 브리핑에 반영 (자바 기능 복원)
  2. (확장) 이슈 1건을 SpecWorkflow로 자동 처리 + 진행 상태·결과를 이슈에 역기록 → "요청 수집 → 작업 수행"의 완성형

---

## 2. 현재 상태 (검증 결과)

| 구성 | 자바 auto-dev | TS auto-dev-ts | issue-tracker (Go) |
|---|---|---|---|
| 이슈 추상화 | `IssueTrackerHook` 인터페이스 | ❌ 없음 | — |
| 구현체 | `JiraIssueTrackerHook` / `NoopIssueTrackerHook` (조건부 와이어링) | ❌ 없음 | — |
| 자동 수집 | `WorklogBriefingTask` `@Scheduled` → fetch → review 브리핑 | ⚠️ 스케줄러는 있으나 정적 프롬프트(이슈 fetch 없음) | — |
| 조회 API | `GET /jira/issues` | ❌ 없음 | `GET /issues` 제공 |
| 데이터 소스 | Jira REST API v3 | — | 자체 REST + SQLite |

> issue-tracker 스키마에 `source`, `linked_run_id` 필드가 이미 존재 → **auto-dev 실행과 연결되도록 처음부터 설계됨**. 이번 연동에서 이 필드를 활용한다.

---

## 3. 연동 대상 API (issue-tracker, 기본 `127.0.0.1:8081`)

| Method | Path | 용도 |
|---|---|---|
| `GET` | `/issues?status=&type=&priority=&q=&mine=` | 이슈 목록 (필터) |
| `GET` | `/issues/{key}` | 단일 이슈 (예: `AD-42`) |
| `PATCH` | `/issues/{key}` | 부분 갱신 (status, linkedRunId 등) |
| `POST` | `/issues` | 이슈 생성 |
| `GET` | `/healthz` | 헬스체크 |

**Issue 모델 (응답 JSON)**
```
key, projectId, number, title, description,
type      ∈ TASK | BUG | IDEA | FOLLOWUP
priority  ∈ HIGH | MED | LOW
status    ∈ OPEN | IN_PROGRESS | DONE | DROPPED
source    (MANUAL 등), linkedRunId?, reporterId, assigneeId?,
createdAt, updatedAt, closedAt?
```

---

## 4. 설계

### 4.1 추상화 (자바 `IssueTrackerHook` 대응, 함수형 스타일)

```typescript
// src/integrations/issue-tracker/types.ts
export interface IssueRef {
  key: string;            // "AD-42"
  title: string;
  description: string;
  type: string;           // TASK | BUG | IDEA | FOLLOWUP
  priority: string;       // HIGH | MED | LOW
  status: string;         // OPEN | IN_PROGRESS | DONE | DROPPED
  updatedAt: string;
}

export interface IssueTracker {
  fetchOpenIssues(): Promise<IssueRef[]>;
  // 확장 단계에서 사용
  getIssue?(key: string): Promise<IssueRef | null>;
  updateIssue?(key: string, patch: { status?: string; linkedRunId?: string }): Promise<void>;
}
```
> auto-dev-ts는 클래스/DI 대신 함수형 모듈을 쓰므로, 인터페이스 + 팩토리 함수로 구현한다.

### 4.2 구현체

- **`httpIssueTracker(baseUrl)`** — issue-tracker REST 호출
  - `fetchOpenIssues()` → `GET /issues?status=OPEN` 결과를 `IssueRef[]`로 매핑
  - `updateIssue()` → `PATCH /issues/{key}`
- **`noopIssueTracker`** — 항상 빈 배열 (설정 없을 때 fallback)

### 4.3 설정 기반 자동 전환 (자바 `@ConditionalOnExpression` 대응)

```typescript
// src/integrations/issue-tracker/index.ts
export function getIssueTracker(): IssueTracker {
  const base = process.env.AUTO_DEV_ISSUE_TRACKER_URL;
  return base ? httpIssueTracker(base) : noopIssueTracker;
}
```

| 환경변수 | 기본값 | 설명 |
|---|---|---|
| `AUTO_DEV_ISSUE_TRACKER_URL` | (없음) | 설정 시 연동 활성, 없으면 Noop |
| `AUTO_DEV_ISSUE_TRACKER_STATUS` | `OPEN` | 수집 대상 상태 필터 |

### 4.4 [필수] 스케줄러 연동 — 자바 브리핑 기능 복원

```typescript
// src/schedule/briefing.ts (수정)
const tracker = getIssueTracker();
const issues = await tracker.fetchOpenIssues();
const summary = issues.length
  ? issues.map(i => `- [${i.key}] ${i.title} (${i.status})`).join('\n')
  : '(이슈 없음 — 트래커 미연동)';
const prompt = `오늘의 워크로그 브리핑.\n할당된 이슈:\n${summary}\n\n먼저 시작할 작업과 고려할 점을 3줄 이내로 요약.`;
await review(prompt, { triggerSource: 'schedule' });
```

### 4.5 [확장] 이슈 → 자동 작업 수행 + 역기록 (자바도 안 했던 차별화)

```
1. getIssue(key) 로 이슈 로드
2. PATCH status=IN_PROGRESS, linkedRunId=<runId>   ← 진행중 표시 + auto-dev 실행과 연결
3. runSpec(issue.description, { triggerSource: 'issue', triggerDetail: key })
4. 결과 verdict 에 따라:
     - SHIP   → PATCH status=DONE
     - 그 외  → status 유지 + 결과 요약을 description/코멘트에 기록
```
> issue-tracker의 `linked_run_id` 필드가 여기서 실제로 쓰인다 (이슈 ↔ 실행 추적 양방향 연결).

---

## 5. 구현 체크리스트

- [ ] `src/integrations/issue-tracker/types.ts` — `IssueRef`, `IssueTracker`
- [ ] `src/integrations/issue-tracker/client.ts` — `httpIssueTracker()` (fetch 기반)
- [ ] `src/integrations/issue-tracker/noop.ts` — `noopIssueTracker`
- [ ] `src/integrations/issue-tracker/index.ts` — `getIssueTracker()` 팩토리
- [ ] `src/schedule/briefing.ts` — 이슈 fetch 연동 (4.4)
- [ ] `src/workflows/from-issue.ts` — 이슈 자동 처리 + 상태/역기록 (4.5, 확장)
- [ ] `src/cli.ts` — `./run issues` (목록), `./run work <key>` (자동 처리) 커맨드 추가
- [ ] `src/server/routes.ts` — `GET /api/issues`, `POST /api/issues/:key/run`
- [ ] `.env.example` — `AUTO_DEV_ISSUE_TRACKER_URL` 등 추가
- [ ] `docs/ARCHITECTURE.md` / `README` — 연동 섹션 갱신
- [ ] 포트폴리오 3.5 "확장 구조" → "동작하는 기능"으로 업데이트

---

## 6. 데이터 매핑 (issue-tracker → IssueRef)

| issue-tracker(Go) | IssueRef(TS) | 비고 |
|---|---|---|
| `key` | `key` | 그대로 |
| `title` | `title` | 그대로 |
| `description` | `description` | SpecWorkflow 입력으로 사용 |
| `type` | `type` | TASK/BUG/IDEA/FOLLOWUP |
| `priority` | `priority` | HIGH/MED/LOW |
| `status` | `status` | OPEN만 기본 수집 |
| `updatedAt` | `updatedAt` | 정렬용 |

---

## 7. 자바 대비 차이 & 개선점

- 데이터 소스: Jira REST(JQL) → **자체 issue-tracker REST**(단순 쿼리 파라미터, 인증 불필요·loopback)
- 구조: 클래스 + Spring DI → **함수형 모듈 + 팩토리**
- 기능: 단순 브리핑 → **이슈 자동 처리 + `linked_run_id` 역기록 추가** (양방향 추적)
- 두 자작 프로젝트(issue-tracker ↔ auto-dev)를 직접 연결 → 포트폴리오 서사 강화

---

## 8. 테스트 계획

- `httpIssueTracker`: issue-tracker 로컬 부팅(`make run`) 후 `fetchOpenIssues` 통합 테스트
- `noopIssueTracker`: 환경변수 미설정 시 빈 배열 fallback 확인
- `briefing`: 이슈 목록이 프롬프트에 반영되는지
- `from-issue`: 상태 전이(OPEN→IN_PROGRESS→DONE) + `linkedRunId` 기록 검증

---

## 9. 리스크 / 고려사항

- issue-tracker는 **인증 없음 + loopback 전용** → auto-dev-ts와 **동일 호스트** 가정.
- 자동 처리 중복/폭주 방지: 이미 `IN_PROGRESS`면 skip, 기존 `costGuard`(일일 실행 한도) 그대로 적용.
- `bypassPermissions` 안전 경계 유지 — 신뢰 환경 전용 원칙 변함 없음.
- 타임스탬프: Go는 RFC3339(`datetime('now')`) → TS에서 `new Date()` 파싱 가능.

---

## 10. 예상 작업량

| 범위 | 내용 | 예상 |
|---|---|---|
| 필수 (4.1~4.4) | 추상화 + 클라이언트 + 브리핑 연동 | 약 반나절 |
| 확장 (4.5) | 이슈 자동 처리 + 역기록 + CLI/API | 추가 반나절~1일 |

---

## 11. 착수 순서 추천

1. **4.1~4.3** (추상화 + 클라이언트 + 팩토리) — 독립적이라 먼저
2. **4.4** (브리핑 연동) — 자바 기능 복원, 눈에 보이는 첫 결과
3. **4.5** (자동 처리) — 차별화 포인트, 시간 될 때
4. 문서/포트폴리오 갱신
