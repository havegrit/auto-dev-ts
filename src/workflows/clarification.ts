import { randomUUID } from 'crypto';
import type { ClarificationQuestion } from './spec.js';

/** clarifier 게이트 한 라운드: 던진 질문 + (있으면) 사용자가 입력한 답변. */
export interface ClarificationRound {
  questions: ClarificationQuestion[];
  /** 질문 id → 사용자 답변. 아직 답하지 않은 라운드는 비어 있다. */
  answers?: Record<string, string>;
}

/** 문자열을 파일명에 안전한 slug 로 변환한다 (영문 소문자화, 공백→하이픈, 한글 등 유지). */
function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** 첫 마크다운 제목(`# ...`) 텍스트를 반환한다. 없으면 undefined. */
function firstHeading(spec: string): string | undefined {
  const m = spec.match(/^#{1,6}\s+(.+)$/m);
  return m ? m[1].trim() : undefined;
}

/**
 * plan 파일명 slug 를 결정한다.
 * 우선순위: 프로젝트명 → 스펙 첫 제목 → `spec-<짧은 uuid>`.
 */
export function planSlug(project: string | undefined, spec: string): string {
  const fromProject = project ? slugify(project) : '';
  if (fromProject) return fromProject;

  const heading = firstHeading(spec);
  const fromHeading = heading ? slugify(heading) : '';
  if (fromHeading) return fromHeading;

  return `spec-${randomUUID().slice(0, 8)}`;
}

/** 답변이 채워진 라운드의 (질문,답) 쌍만 평탄화해 시간순으로 반환한다. */
function answeredPairs(rounds: ClarificationRound[]): Array<{ q: ClarificationQuestion; answer: string }> {
  const pairs: Array<{ q: ClarificationQuestion; answer: string }> = [];
  for (const round of rounds) {
    const answers = round.answers ?? {};
    for (const q of round.questions) {
      const answer = answers[q.id];
      if (answer != null && String(answer).trim()) {
        pairs.push({ q, answer: String(answer).trim() });
      }
    }
  }
  return pairs;
}

/**
 * 원본 스펙 뒤에 지금까지의 의사결정(Q&A) 블록을 덧붙여 clarifier 재입력 문자열을 만든다.
 * 답변된 라운드가 없으면 스펙을 그대로 반환한다.
 * clarifier.system.md 가 기대하는 "이전 Q&A:" 포맷을 따른다.
 */
export function composeClarifierInput(spec: string, rounds: ClarificationRound[]): string {
  const pairs = answeredPairs(rounds);
  if (pairs.length === 0) return spec;

  const lines = pairs.map(({ q, answer }) => `- ${q.id} (${q.category}): ${q.text} → 답: ${answer}`);
  return `${spec}\n\n## 이전 Q&A (사용자 의사결정)\n${lines.join('\n')}`;
}

/**
 * docs/plan 에 기록할 마크다운 문서를 조립한다.
 * 원본 스펙 + 라운드별 의사결정 히스토리 + (있으면) planner 산출 플랜을 담는다.
 */
export function renderPlanDoc(opts: {
  project?: string;
  spec: string;
  rounds: ClarificationRound[];
  planOutput?: string;
  now?: Date;
}): string {
  const now = opts.now ?? new Date();
  const title = opts.project ?? firstHeading(opts.spec) ?? 'spec';
  const sections: string[] = [
    `# Plan: ${title}`,
    `_업데이트: ${now.toISOString()}_`,
    `## 원본 스펙\n\n${opts.spec.trim()}`,
  ];

  const decided = opts.rounds.filter(r => answeredPairs([r]).length > 0);
  if (decided.length > 0) {
    const rounds = decided.map((round, i) => {
      const entries = answeredPairs([round])
        .map(({ q, answer }) => `- **${q.id} (${q.category})** ${q.text}\n  - 답변: ${answer}`)
        .join('\n');
      return `### Round ${i + 1}\n\n${entries}`;
    });
    sections.push(`## 의사결정 히스토리\n\n${rounds.join('\n\n')}`);
  }

  if (opts.planOutput?.trim()) {
    sections.push(`## 플랜\n\n${opts.planOutput.trim()}`);
  }

  return `${sections.join('\n\n')}\n`;
}
