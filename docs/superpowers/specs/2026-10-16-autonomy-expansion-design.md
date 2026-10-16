# 자율성 확장 설계

- 날짜: 2026-10-16
- 상태: Phase 7A/7B/7C 구현 완료, Phase 7D 미구현
- 범위: 재시작 내성, PR 전달, 제한적 자동 머지

## 요약

Phase 7에서는 성공 판정을 더 자율적으로 만들기 전에, 중단된 실행을 안전하게 이어가고 검증된 결과를 검토 가능한 PR로 전달한다. 자동 머지는 프로젝트의 명시적 opt-in과 연속된 eval 및 실사용 성공 기록이 모두 있을 때만 허용한다.

| 결정 | 설계 |
|---|---|
| 실행 복구 | 재개를 opt-in한 프로젝트에서 SQLite 체크포인트와 만료 가능한 실행 lease로 안전한 지점부터 재개한다. |
| PR 전달 | 기본 동작은 유지한다. 프로젝트가 PR 모드를 명시한 경우에만 run 전용 브랜치를 push하고 PR을 만든다. |
| 자동 머지 | 기본 비활성. 사람이 보호된 기본 브랜치에 설정한 opt-in, 저위험 변경 분류, 측정 기준, 저장소 보호 규칙이 모두 필요하다. |
| 범위 | A/B/C는 별도 구현 작업으로 완료했다. C는 read-only dry-run이며, D의 실제 merge 실행은 별도 승인 대상이다. |

## 배경과 현재 동작

- **src/workflows/spec.ts**의 cursor, routeCount, pendingFeedback, planOutput과 단계 결과는 runSpec() 메모리에 있다. 에이전트 실행 결과는 **agent_run**에 저장되지만, 다음 단계와 라우팅 상태를 복원할 체크포인트는 없다.
- **src/store/db.ts**는 시작 시 RUNNING인 모든 agent_run을 FAILED와 server_restart로 바꾼다. 이 동작은 복구 가능한 워크플로와 고아 실행을 구분하지 않는다.
- **src/lib/run-cancellation.ts**의 취소 핸들은 프로세스 메모리의 Map에만 있다.
- 성공 후 **src/workflows/post-success-commit.ts**가 문서 확인과 로컬 atomic commit을 수행한다. 원격 브랜치나 PR을 만들지 않는다.
- Phase 3 증거는 **data/evidence/<workflowRunId>/evidence.json**에 저장되고 **/api/runs/:id/evidence**로 제공된다. PR에서 열 수 있는 외부 기본 URL이나 대시보드의 run deep link는 아직 없다.
- **src/workflows/team.ts**는 작업별 임시 worktree에서 실행한 커밋을 원본 checkout에 cherry-pick한다. 이 통합 지점도 재시작 복구 대상이어야 한다.

## 목표와 제외 범위

### 목표

1. 서비스 재시작 뒤 워크플로의 입력, 현재 단계, 재작업 상태와 검증 결과를 복원한다.
2. 중복 에이전트 실행, 중복 cherry-pick, 중복 PR 생성, 의도하지 않은 중복 머지를 방지한다.
3. PR의 코드 상태와 verify 증거를 서로 연결해 사람이 확인할 수 있게 한다.
4. 자동 머지의 자격과 판단 근거를 재현 가능한 데이터로 남긴다.

### 제외 범위

- Phase 7C는 자동 머지 자격을 읽기 전용으로 계산하며, 실제 `gh pr merge`를 호출하지 않는다.
- 이 문서는 실저장소 자동 머지 실행이나 배포 승인을 대신하지 않는다.
- 체크포인트가 없는 과거 run을 추측해 재생하지 않는다.
- .auto-dev/ 설정이 없는 프로젝트의 실행 경로와 재시작 실패 처리는 그대로 둔다.
- 일반 기능 변경, 버그 수정, 리팩터링을 자동 머지 대상으로 확대하지 않는다.
- GitHub 외 호스팅 서비스 지원은 첫 구현 범위에 넣지 않는다.

## 1. 체크포인트와 재시작 복구

### 저장 모델

새 **workflow_checkpoint** 테이블을 둔다. **agent_run**은 실행 이력과 UI 상태를 계속 담당하고, 체크포인트는 오케스트레이터가 재개에 필요한 직렬화 상태를 담당한다.

| 필드 | 용도 |
|---|---|
| workflow_run_id | 최상위 spec run ID이자 기본 키. agent_run(id)를 참조한다. |
| schema_version | 체크포인트 JSON 형식 버전. |
| revision | 단조 증가 fencing 값. 오래된 worker가 새 상태를 덮어쓰지 못하게 한다. |
| state | READY, RUNNING, WAITING_USER, DELIVERY_PENDING, SUCCEEDED, FAILED, CANCELLED, RECOVERY_REQUIRED 중 하나. |
| snapshot_json | 입력, 실행 옵션, 단계 cursor, 재작업 상태, 팀 DAG 상태, 전달 상태를 담는다. |
| lease_owner, lease_expires_at, heartbeat_at | worker 소유권과 생존 확인. |
| updated_at | 마지막 체크포인트 시각. |

스냅샷에는 최소한 다음 값을 보존한다.

- 원본 spec, clarified spec, 실행 당시 대상 경로와 설정 스냅샷
- cursor, routeCount, pendingFeedback, planOutput, results
- 실행을 재현하는 데 필요한 직렬화 가능한 옵션: 단계 필터, 최대 route, 모델별 선택, trigger 정보
- 진행 중인 작업의 종류와 agent_run ID, 마지막으로 완료한 작업 ID
- 동적 팀의 노드별 상태·커밋 SHA·통합 상태
- verify/runtime evidence ID와 실패·취소 상태
- PR 모드라면 base SHA, 브랜치, worktree 경로, commit SHA, PR 번호/URL, 전달 단계

AbortSignal, 인증 토큰, 프로세스 내부 객체는 저장하지 않는다. 대상 프로젝트의 비밀 설정을 스냅샷에 복사하지 않는다. 필요한 설정은 실행 시점의 검증된 project config에서 다시 읽고, 체크포인트에 설정 fingerprint를 보관한다.

### 체크포인트 시점과 상태 전이

오케스트레이터는 다음 경계마다 하나의 SQLite transaction으로 상태를 기록한다.

1. 단계나 외부 작업을 시작하기 전: action intent와 입력 fingerprint 저장
2. 에이전트가 끝난 직후: child run ID, 출력 참조, 상태, 새 cursor와 route 상태 저장
3. 라우팅, 사용자 대기, 취소, verify/runtime 종료 시
4. commit, push, PR 생성, merge 요청 전후

    READY → RUNNING → WAITING_USER → RUNNING
                     ↘ DELIVERY_PENDING → SUCCEEDED
                     ↘ SUCCEEDED / FAILED / CANCELLED
                     ↘ RECOVERY_REQUIRED

사용자 답변 대기와 전송 재시도는 완료 상태와 분리한다. PR 단계가 실패해도 검증된 코드와 verify 성공을 잃지 않고 DELIVERY_PENDING으로 남겨 전송 작업만 다시 시도한다.

### 재개 규칙

- 서버 시작 시 DB migration을 완료한 뒤, lease가 만료된 RUNNING 체크포인트만 복구 후보로 조회한다.
- 후보를 transaction으로 다시 claim하고 revision을 증가시킨다. 같은 체크포인트를 두 서버가 동시에 실행하지 못하게 한다.
- 같은 호스트의 이전 PID가 살아 있으면 소유 프로세스와 경합하지 않도록 claim을 미루고 다음 검사까지 기다린다. lease 소유를 판정할 수 없거나 다른 host 소유라면 재개하지 않고 RECOVERY_REQUIRED로 둔다.
- 서버가 중단된 시점이 에이전트 호출 중이면, 이전 시도는 server_restart 원인으로 종료 이력에 남기고 **같은 단계 입력으로 새 child run을 만든다**. LLM 호출을 정확히 한 번 실행하는 보장은 제공하지 않는다. 중단 전에 남은 파일 변경은 보존하고, 재실행 뒤 결정적 verify를 다시 실행한다.
- child run이 DONE이고 체크포인트 커서만 이전 상태라면 저장된 child 결과를 소비해 다음 단계로 이동한다. 이미 완료한 에이전트 호출을 다시 실행하지 않는다.
- runtime 검증 중 중단된 경우 안정적인 run별 Compose 이름으로 먼저 down 정리를 시도하고, 정리 확인 후 검증을 처음부터 재실행한다. 정리를 확인할 수 없으면 수동 복구 상태로 둔다.
- 동적 팀은 완료된 노드와 commit SHA를 유지한다. 재개 시 미완료 노드만 시작하고, 통합 전에 해당 커밋이 이미 대상 worktree의 조상인지 확인해 cherry-pick 중복을 막는다.
- 취소는 DB 상태를 CANCELLED로 남기고 현재 child/프로세스 그룹의 종료를 기다린다. 재시작 뒤 취소된 run은 자동 재개하지 않는다.
- 체크포인트가 없는 기존 RUNNING 행은 기존처럼 고아 실행으로 처리해 server_restart 실패 기록을 남긴다. 마이그레이션이 과거 run을 임의로 재실행하지 않는다.
- 체크포인트 opt-in 전의 신규 run도 기존 동작을 유지한다. 새 체크포인트는 workflow.resumeOnRestart: true 또는 PR 모드에서만 생성한다.

### 실행 디렉터리 보호

- workflow.resumeOnRestart: true 또는 PR 모드는 항상 run 전용 linked worktree에서 실행한다. branch와 base SHA를 실행 시작 전에 저장한다. 이 worktree 안의 부분 변경은 해당 run 소유로 한정해, 프로세스 종료를 확인한 뒤 미완료 단계를 재실행할 수 있다.
- 재개 가능한 local 모드는 시작 checkout이 clean해야 한다. 미커밋 사용자 변경을 run worktree에 복사하지 않고, 시작 전 설정 오류로 중단한다.
- 재개 가능한 local 모드는 완료 시 생성된 commit을 원래 checkout에 순서대로 cherry-pick한다. 원래 checkout이 시작 당시 base SHA에서 벗어났거나 미커밋 변경이 있으면 자동 통합하지 않고 DELIVERY_PENDING에 보존한다. 사용자는 결과 branch를 검토하거나 원래 checkout을 정리한 뒤 재시도할 수 있다.
- 기본 local 모드는 기존 프로젝트 경로를 사용해 하위 호환을 유지한다. 이 경로는 재시작 자동 재개에 opt-in하지 않은 상태다. team 작업은 재개 opt-in 시 기존 임시 worktree를 체크포인트와 연결하고, 서버가 끝났다는 이유로 미완료 worktree를 즉시 삭제하지 않는다.

## 2. PR 전달

### 설정과 기본 동작

현재 프로젝트 설정에 다음 의미를 갖는 delivery 설정을 추가한다.

| 설정 | 의미 |
|---|---|
| delivery.mode | local 또는 pull-request. 생략하면 local을 적용한다. |
| delivery.baseBranch | PR 대상 브랜치. 생략 시 remote의 기본 브랜치를 확인한다. |
| delivery.autoMerge.enabled | 자동 머지 opt-in. 기본값은 false. |
| workflow.resumeOnRestart | local 모드에서 재시작 복구 opt-in. 기본값은 false. true이면 run 전용 worktree를 쓴다. |

.auto-dev/project.json이 없거나 delivery.mode가 pull-request가 아니면 현재 로컬 작업·커밋 흐름을 유지하고 자동 push/PR/merge를 하지 않는다. workflow.resumeOnRestart도 생략하면 현재 in-place 실행과 server_restart 처리를 유지한다. PR 모드는 재개 기능을 포함하며, 필수 설정, GitHub remote, gh 인증, 증거 공개 URL을 실제 에이전트를 시작하기 전에 검사한다. 잘못된 설정은 명확한 오류로 종료한다.

자동 머지 설정은 실행 대상 worktree가 아니라 실행 시작 시 기준 브랜치에서 읽은 설정만 인정한다. PR 변경이 설정을 추가하거나 enabled를 켜더라도 해당 PR 자신에게 적용하지 않는다.

### PR 생성 순서

1. remote와 base branch를 확인하고 base SHA를 기록한다.
2. data/worktrees/<workflowRunId>에 전용 worktree와 autodev/<runId 앞 8자리> 브랜치를 만든다. 기존 checkout의 미커밋 변경은 포함하지 않는다.
3. planner부터 review, 결정적 verify/runtime gate, 문서 점검을 worktree에서 완료한다.
4. 검증된 파일만 commit하고 commit SHA를 저장한다.
5. branch를 일반 git push로 push한다. force push는 금지한다.
6. 같은 head/base 조합의 PR이 이미 있는지 확인한다. 없으면 gh pr create를 실행하고, 이미 있으면 run 식별자와 head SHA를 확인해 재사용한다.
7. PR URL과 저장소 상태를 검증한 다음 체크포인트와 run 결과에 기록한다.

commit/push/PR 각 작업 직전에 intent를 체크포인트에 남긴다. 재시작 뒤 원격 상태를 조회해 이미 끝난 작업은 확인만 하고, 같은 PR을 두 번 만들지 않는다. 저장소 상태가 기록과 다르면 branch를 force-update하거나 PR을 수정하지 않고 RECOVERY_REQUIRED로 둔다.

PR 생성 실패는 코드 검증 실패와 별도로 표시한다. 검증이 통과한 worktree와 commit은 보존하고 DELIVERY_PENDING에서 push/PR 단계만 재시도할 수 있어야 한다. 실패 이유, 재시도 버튼, run별 branch와 commit 정보를 상세 화면에서 제공한다.

### PR 본문과 증거 링크

PR 본문에는 다음을 포함한다.

- 요청 요약, PR head SHA와 base SHA
- verify 명령, 종료 코드, 소요 시간, 통과/실패 결과
- runtime healthcheck 및 결정적 checks 결과(설정된 경우)
- 리뷰 판정과 관련된 evidence 요약
- 해당 workflow 상세/evidence를 여는 링크

현재 evidence API는 서버 로컬 주소만으로 외부에서 접근할 수 없다. PR 모드는 AUTO_DEV_PUBLIC_BASE_URL을 요구하고, 대시보드에 /?run=<workflowRunId> 형태의 직접 열기 URL을 추가한다. 링크는 HTTPS를 사용하고 조직의 접근 제어를 따른다. 서버에 인증이나 네트워크 접근 제어가 구성되지 않으면 evidence endpoint를 외부에 공개하지 않는다. 공개 URL을 안전하게 제공할 수 없으면 PR 모드는 시작하지 않는다.

PR 본문에는 토큰, 비밀값, 요청/응답의 민감한 본문, 원시 로그 전체를 넣지 않는다. evidence API에는 허용된 요약만 노출하고, 기존 대시보드 인증 경계를 우회하는 공개 링크를 만들지 않는다.

## 3. 제한적 자동 머지

### 저위험 분류

분류는 모델의 설명이나 review 마커를 신뢰하지 않고 base와 PR head의 실제 diff로 결정한다.

| 분류 | 자동 머지 후보 조건 |
|---|---|
| 문서 | 변경 파일이 보호된 allowlist(예: docs/**, README, 명시된 changelog)에만 있고 실행 코드, workflow, 설정, 의존성 파일 변경이 없다. |
| 의존성 패치 | 사전에 허용한 package manifest와 lockfile만 바뀌고, 소스·빌드 스크립트·CI 정의가 바뀌지 않으며 보안/라이선스 정책과 결정적 checks를 통과한다. |
| 기타 | 자동 머지 불가. 기본적으로 사람 검토를 요구한다. |

allowlist는 auto-dev 서버가 관리하는 정책으로 유지한다. 프로젝트 설정이나 PR이 분류 규칙을 느슨하게 만들 수 없다. 경로 분류가 모호하거나 새 파일 유형이 있으면 자동 머지를 거부한다.

### 신뢰 기준 제안

다음 값은 구현 승인 시 조정할 수 있는 보수적 초기값이다. 프로젝트 설정은 이 최소 기준을 낮출 수 없다.

- **Eval:** 동일한 모델/프롬프트/검증 정책 fingerprint에서 대상 저위험 분류의 최근 20회 평가가 연속 통과하고, 그 안에 서로 다른 적격 case가 10개 이상 포함되어야 한다. 실패, 회귀, 타임아웃은 streak를 초기화한다.
- **실사용:** 사람이 확인하고 merge한 저위험 PR 10개가 연속으로 통과하고, 각 PR이 merge 후 14일 관찰 기간에 revert, hotfix, 재작업 이슈 없이 안정 상태여야 한다. 해당 기간의 실패나 되돌림은 streak를 초기화한다.
- 모델, 주요 프롬프트, verify 정책 또는 분류기 버전이 바뀌면 해당 정책 fingerprint와 일치하지 않는 eval/live 기록은 자격 산정에서 제외한다. 기록이 부족하거나 오래됐으면 자동 머지 자격이 없다.
- 현재 eval 케이스는 3개뿐이므로 위 제안 기준을 충족하지 않는다. 초기 배포에서는 자동 머지가 계속 비활성 상태여야 한다.

Eval 기록은 data/evals의 결과를 case ID, 모델, 설정 fingerprint에 연결해 집계한다. 실사용 기록은 PR 번호/head SHA, 승인 주체, merge 시각, 관찰 기간, revert/hotfix/rework 결과를 저장한다. 완료 여부를 확인할 수 없는 PR은 성공으로 세지 않는다.

### 머지 실행 게이트

자동 머지는 아래 조건을 매번 다시 확인한다.

1. 기준 브랜치에서 읽은 delivery.autoMerge.enabled가 true이고 서버 전역 kill switch가 켜져 있지 않다.
2. 변경이 저위험 allowlist에 정확히 들어맞는다.
3. verify, runtime checks, review 및 증거 보존이 모두 통과했다.
4. 위 eval 및 실사용 streak가 같은 정책 fingerprint로 충족된다.
5. PR head SHA가 검증을 통과한 SHA와 같고, base와 충돌하지 않는다.
6. 기본 브랜치에 branch protection과 하나 이상의 필수 CI status check가 설정되어 있고, 모든 필수 check를 통과한다. auto-dev는 보호 규칙이나 필수 승인을 우회하지 않는다.

조건이 하나라도 충족되지 않으면 PR만 생성하고 사람 검토를 기다린다. 승인 대기 중 head가 바뀌면 검증을 다시 수행한다. 자동 머지 요청, 취소, 거부, 완료 결과는 누가/언제/어떤 정책과 증거로 결정했는지 감사 이벤트로 남긴다.

초기 구현은 자동 머지 코드를 넣더라도 관측 전용(dry-run)으로 시작한다. 기준선이 충족되고 프로젝트에서 별도로 opt-in한 뒤에만 실제 gh pr merge --auto를 활성화한다. 서버 관리자는 즉시 전체 자동 머지를 끌 수 있어야 한다.

## 4. 구현 단계와 완료 기준

이 문서 승인 뒤 구현을 별도 작업으로 나눠 진행한다.

| 단계 | 구현 범위 | 완료 조건 |
|---|---|---|
| A | 체크포인트 저장, lease, 시작 시 복구, UI 상태 노출 | 지원하는 순차 dashboard spec은 안전한 경계에서 재개하고, 모호한 상태는 보존 후 안전하게 멈춘다. |
| B | run 전용 PR worktree, commit/push/PR 생성, 증거 deep link | gh와 git 호출 mock 테스트, 원격 작업의 재시작/idempotency 테스트, PR 본문 증거 링크 검증을 통과한다. |
| C | eval/실사용 streak 집계와 자동 머지 dry-run | 기준선 부족, 분류 불명, fingerprint 변경, revert, head 변경에서 모두 자동 머지가 거부된다. |
| D | 별도 승인된 프로젝트의 자동 머지 파일럿 | 정책·로그·kill switch 확인 후 opt-in 프로젝트에서만 동작하며, 보호 규칙을 우회하지 않는다. |

구현 완료 시 npm test, npx tsc --noEmit, docs 갱신이 필요하다. 테스트에서는 실제 LLM, Docker, 원격 push, 실제 PR/merge를 호출하지 않고 각 외부 경계를 mock한다. 별도의 승인된 staging 절차가 없으면 실저장소 쓰기 테스트를 하지 않는다.

### Phase 7A 구현 범위 조정 (2026-10-16)

첫 구현은 체크포인트 저장·lease·복구 상태 노출을 제공하되, run 전용 worktree 및 원본
checkout 통합은 후속 구현으로 미룬다. 재시작 복구는 대시보드에서 명시적으로 opt-in한
순차 spec에 한정하고, 시작 당시 Git 작업 트리가 깨끗해야 한다. 완료 child 결과는 재사용하며,
진행 중인 에이전트는 `AGENT_SPECS`에서 `Read` 전용일 때만 시작 전 파일 해시와 HEAD가
동일하면 재실행한다. 쓰기 권한이 있는 에이전트는 gitignore 파일 변경을 배제할 수 없어
재실행하지 않는다. 동적 팀,
verify/runtime, 성공 후 전달 작업 중단이나 상태 불일치는 `RECOVERY_REQUIRED`로 멈추고
변경 파일을 보존한다. 실행 도중 작성한 변경은 원본 checkout에 남으므로 수동 검토가 필요할
수 있다. run 전용 worktree는 별도 범위에서 완료 기준과 함께 추가한다.

### Phase 7B 구현 범위 조정 (2026-10-16)

- `delivery.mode: "pull-request"`는 dashboard/API/CLI spec을 체크포인트 세션으로 시작하고,
  GitHub origin의 base SHA에서 run 전용 worktree와 `autodev/<id8>` branch를 만든다.
  issue tracker 진입은 bug 재현 단계가 아직 worktree를 공유하지 않으므로 에이전트 시작 전에
  명확히 거부한다.
- 성공한 review 이후 docs audit, 오케스트레이터 commit, 일반 push, 기존 PR 조회/생성까지
  연결한다. 재시작 뒤 commit marker, remote SHA, head/base PR을 확인해 중복 생성이나 force
  update를 막는다. 전달 실패는 코드 성공과 분리해 `DELIVERY_PENDING`에 저장하고 dashboard에서
  재시도한다.
- PR 본문에는 짧은 요청 요약, 검증·리뷰 상태, base/head SHA와 dashboard deep link만 넣는다.
  외부 접근 제어는 `AUTO_DEV_PUBLIC_ACCESS_CONTROL` 운영자 확인값이다. 앱은 인증을 추가하거나
  reverse proxy 설정을 검사하지 않으므로, 모든 dashboard/API 경로를 보호하는 HTTPS proxy가
  실제로 구성돼야 한다.
- 구현 테스트는 git/gh 호출을 모두 mock하며 실제 원격 push/PR은 만들지 않는다. 자동 머지
  자격 dry-run과 eval/live streak 집계는 Phase 7C에서 추가했고, staging 실저장소 쓰기는 하지 않는다.

### Phase 7C 구현 범위 조정 (2026-10-16)

- `delivery.autoMerge.enabled`는 PR workflow의 dry-run 자격 평가만 opt-in한다. 실제 merge 명령은
  구현하지 않았으며, 대시보드·checkpoint·`auto_merge_dry_run` 감사 테이블에 결과와 거부 이유를 남긴다.
- diff 분류는 서버 소유 allowlist를 사용한다. 정책 fingerprint, verify/runtime 증거, review,
  current head approval, branch protection, required checks, eval 20회/10개 case, live 10개 PR/14일을
  모두 통과해야 dry-run eligible로 표시한다. 기준은 프로젝트 설정으로 낮출 수 없다.
- live 성공 증거는 PR 작성자와 다른 사람의 현재 head 승인, 사람 계정의 merge, 병합 14일 뒤
  사람이 추가한 현재 `auto-dev/merge-stable` 라벨을 요구한다. revert/hotfix/rework 라벨,
  변경된 head, 불완전한 이벤트 이력, bot 병합은 streak에 포함하지 않는다.
- 현재 기본 eval 세트는 `autoMergeCategory`를 선언하지 않아 자격 기준선이 없다. 추가 eval 케이스와
  실제 GitHub 이력 없이는 dry-run이 거부되는 상태가 정상이다.

## 구현 승인 전에 확정할 사항

1. 실제 merge 파일럿에 사용할 대상 저장소/조직과 branch protection 최소 설정.
2. AUTO_DEV_PUBLIC_BASE_URL이 가리킬 대시보드의 배포 방식과 접근 제어.
3. 자동 머지 운영 중 live 성공·revert·hotfix를 수집할 GitHub 조회 주기와 재인증 절차.

Phase 7C의 자격 집계와 dry-run은 구현됐다. Phase 7D의 실제 merge 파일럿은 대상 저장소,
전역 kill switch, 감사/롤백 절차를 확정한 별도 승인 뒤에만 구현한다.
