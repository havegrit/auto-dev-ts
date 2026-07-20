import { db } from './db.js';
import type { ClarificationRound } from '../workflows/clarification.js';

/**
 * spec 워크플로우가 clarifier 게이트에서 멈췄을 때, 답변 입력만으로 재개하기 위한
 * 전체 상태. 원본 스펙(잘리지 않은 전문) + 프로젝트/plan 파일 위치 + 라운드별 Q&A 를 담는다.
 */
export interface ClarificationState {
  spec: string;
  project?: string;
  slug: string;
  /** cwd 기준 plan 파일 상대 경로 (docs/plan/<slug>.md). */
  planFile: string;
  /** 에이전트 실행 cwd (프로젝트 절대경로). */
  cwd: string;
  /** 이 run 이 실행해야 하는 spec 단계 필터. undefined 면 전체 파이프라인. */
  steps?: string[];
  /** review/test 피드백을 planner/clarifier로 되돌리는 최대 횟수. */
  iterations?: number;
  /** 중단 후 재개할 때도 자동 구체화 설정을 유지한다. */
  autoClarify?: boolean;
  /** 자동 구체화 최대 라운드. 0이면 무제한. */
  maxClarifyRounds?: number;
  rounds: ClarificationRound[];
  /** 이 run 의 planner 산출 플랜. 나중에 대시보드에서 이전 플랜을 보여주는 데 쓴다. */
  planOutput?: string;
}

export function saveClarificationState(runId: string, state: ClarificationState): void {
  db.prepare('UPDATE agent_run SET clarification_state = @state WHERE id = @id')
    .run({ id: runId, state: JSON.stringify(state) });
}

export function getClarificationState(runId: string): ClarificationState | undefined {
  const row = db.prepare('SELECT clarification_state FROM agent_run WHERE id = ?').get(runId) as
    | { clarification_state?: string }
    | undefined;
  if (!row?.clarification_state) return undefined;
  try {
    return JSON.parse(row.clarification_state) as ClarificationState;
  } catch {
    return undefined;
  }
}
