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
  rounds: ClarificationRound[];
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
