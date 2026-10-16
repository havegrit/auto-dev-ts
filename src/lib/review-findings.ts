import { relative, resolve } from 'node:path';
import { emitRunEvent } from './run-events.js';
import { expandHome, WORKSPACE_ROOT } from './workspace.js';
import { insertReviewFindings, type ReviewFindingCandidate, type ReviewFindingInsert } from '../store/review-findings.js';

export type FindingSeverity = 'blocker' | 'high' | 'medium' | 'low';

export interface ParsedReviewFinding {
  severity: FindingSeverity;
  category: string;
  rule_hint: string;
  file?: string;
}

const VALID_SEVERITIES = new Set<FindingSeverity>(['blocker', 'high', 'medium', 'low']);
const MAX_FINDINGS = 100;

function normalizedText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const text = value.trim();
  if (!text) throw new Error(`${label} must not be empty`);
  if (text.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters`);
  return text;
}

/** review 출력의 기계 판독 findings 블록을 검증한다. */
export function parseReviewFindings(output: string): ParsedReviewFinding[] {
  const blocks = [...output.matchAll(/(?:^|\r?\n)FINDINGS_JSON:\s*([\s\S]*?)\s*END_FINDINGS\.?/g)];
  if (blocks.length !== 1) throw new Error(blocks.length === 0 ? 'FINDINGS_JSON block is missing' : 'multiple FINDINGS_JSON blocks found');

  let jsonText = blocks[0][1].trim();
  const fenced = jsonText.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) jsonText = fenced[1].trim();

  let value: unknown;
  try {
    value = JSON.parse(jsonText);
  } catch {
    throw new Error('FINDINGS_JSON is not valid JSON');
  }
  if (!Array.isArray(value)) throw new Error('FINDINGS_JSON must be an array');
  if (value.length > MAX_FINDINGS) throw new Error(`FINDINGS_JSON exceeds ${MAX_FINDINGS} entries`);

  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`finding ${index + 1} must be an object`);
    }
    const row = item as Record<string, unknown>;
    const severityText = normalizedText(row.severity, `finding ${index + 1} severity`, 20).toLowerCase();
    if (!VALID_SEVERITIES.has(severityText as FindingSeverity)) {
      throw new Error(`finding ${index + 1} severity is unsupported`);
    }
    const category = normalizedText(row.category, `finding ${index + 1} category`, 100).toLowerCase();
    const ruleHint = normalizedText(row.rule_hint, `finding ${index + 1} rule_hint`, 1_200);
    let file: string | undefined;
    if (row.file !== undefined && row.file !== null && row.file !== '') {
      file = normalizedText(row.file, `finding ${index + 1} file`, 1_000);
    }
    return { severity: severityText as FindingSeverity, category, rule_hint: ruleHint, ...(file ? { file } : {}) };
  });
}

export function projectFindingKey(projectDir: string): string {
  const workspace = resolve(expandHome(WORKSPACE_ROOT));
  const project = resolve(expandHome(projectDir));
  return relative(workspace, project) || '.';
}

export function formatReviewFindingCandidates(candidates: ReviewFindingCandidate[]): string {
  if (candidates.length === 0) return '(최근 14일 반복 지적 없음)';
  const byProject = new Map<string, ReviewFindingCandidate[]>();
  for (const candidate of candidates) {
    const rows = byProject.get(candidate.project) ?? [];
    rows.push(candidate);
    byProject.set(candidate.project, rows);
  }
  return [...byProject.entries()].map(([project, rows]) => [
    `### ${project === '.' ? '워크스페이스 루트' : project}`,
    ...rows.map((row) => `- [${row.category}] ${row.rule_hint} (${row.count}회${row.sample_file ? `, 예: ${row.sample_file}` : ''})`),
  ].join('\n')).join('\n\n');
}

function warnFindingWrite(runId: string, message: string): void {
  try {
    emitRunEvent(runId, { type: 'warn', ts: new Date().toISOString(), data: message.slice(0, 1_000) });
  } catch {
    // Findings 저장 실패가 review/workflow 결과를 바꾸지 않도록 경고 기록도 best effort로 남긴다.
  }
}

export function captureReviewFindings(
  output: string,
  runId: string,
  workflowRunId: string,
  project: string,
): number {
  let parsed: ParsedReviewFinding[];
  try {
    parsed = parseReviewFindings(output);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warnFindingWrite(runId, `review_findings_parse_failed: ${reason}`);
    return 0;
  }

  try {
    const rows: ReviewFindingInsert[] = parsed.map((finding) => ({
      runId,
      workflowRunId,
      project,
      severity: finding.severity,
      category: finding.category,
      ruleHint: finding.rule_hint,
      file: finding.file,
    }));
    insertReviewFindings(rows);
    return rows.length;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warnFindingWrite(runId, `review_findings_store_failed: ${reason}`);
    return 0;
  }
}

export function recordOperationalFinding(finding: ReviewFindingInsert): void {
  try {
    insertReviewFindings([finding]);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warnFindingWrite(finding.runId, `operational_finding_store_failed: ${reason}`);
  }
}
