import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { LENSES } from './review/lenses.js';

/**
 * 단계별 에이전트의 역할 경계를 한곳에서 정의한다 (single source of truth).
 *
 * `tools` 가 곧 하드 enforcement 다:
 * - 애플리케이션 소스 코드 구현은 `Write`+`Bash` 를 가진 scaffold 만 가능.
 * - test 는 테스트 코드 작성을 위해 `Write`+`Bash` 를 갖되, 프로덕션 소스 수정은
 *   프롬프트(test.system.md)에서 금지한다.
 * - cicd 는 CI/CD 설정 파일 작성을 위해 `Write` 만 갖는다 (`Bash` 없음 → 배포/빌드 실행 불가).
 * - planner·clarifier·review 는 `Read` 만 가져 물리적으로 파일을 쓸 수 없다.
 *
 * 자세한 정책은 docs/ARCHITECTURE.md §5.0 참고.
 */
export interface AgentSpec {
  /** prompts/ 아래 시스템 프롬프트 파일명 */
  promptFile: string;
  /** SDK allowedTools — 이 배열이 구현 권한의 하드 경계다 */
  tools: string[];
  /** 병렬 fan-out 서브에이전트 (review 전용) */
  subagents?: Record<string, AgentDefinition>;
}

export const AGENT_ORDER = ['clarifier', 'planner', 'scaffold', 'test', 'review', 'cicd'] as const;

export const AGENT_SPECS: Record<string, AgentSpec> = {
  clarifier: { promptFile: 'clarifier.system.md', tools: ['Read'] },
  planner: { promptFile: 'planner.system.md', tools: ['Read'] },
  scaffold: { promptFile: 'scaffold.system.md', tools: ['Read', 'Write', 'Bash'] },
  test: { promptFile: 'test.system.md', tools: ['Read', 'Write', 'Bash'] },
  review: { promptFile: 'review.system.md', tools: ['Read'], subagents: LENSES },
  cicd: { promptFile: 'cicd.system.md', tools: ['Read', 'Write'] },
  // 성공한 spec의 내부 후처리 단계. AGENT_ORDER 밖에 두어 일반 실행/UI에는 노출하지 않는다.
  'checking-docs-before-commit': { promptFile: 'checking-docs-before-commit.system.md', tools: ['Read', 'Write', 'Bash'] },
  'atomic-commit': { promptFile: 'atomic-commit.system.md', tools: ['Read', 'Bash'] },
  // 동적 팀 merge conflict 전용 내부 에이전트. 일반 agent picker에는 노출하지 않는다.
  integrator: { promptFile: 'integrator.system.md', tools: ['Read', 'Write', 'Bash'] },
};
