import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import type { AgentRunOpts } from '../agents/dispatch.js';
import { runNamedAgent } from '../agents/dispatch.js';
import { AGENT_ORDER, AGENT_SPECS } from '../agents/specs.js';
import type { RunResult } from '../lib/runner.js';

const execFileAsync = promisify(execFile);

export const TEAM_PLAN_START = 'TEAM_PLAN:';
export const TEAM_PLAN_END = 'END_TEAM_PLAN.';
export const MAX_TEAM_DEPTH = 2;
export const DEFAULT_TEAM_CONCURRENCY = 4;
export const MAX_TEAM_TASKS = 32;

export interface TeamTaskDefinition {
  id: string;
  agent: string;
  input: string;
  dependsOn?: string[];
  /** 수정 작업이면 worktree를 만들고 결과를 통합한다. */
  writes?: boolean;
}

export interface TeamPlan {
  version: 1;
  tasks: TeamTaskDefinition[];
  maxConcurrency?: number;
}

export interface TeamTaskResult {
  taskId: string;
  agent: string;
  run?: RunResult;
  status: 'DONE' | 'FAILED' | 'BLOCKED' | 'CANCELLED';
  output: string;
  changedFiles?: string[];
  worktree?: string;
  error?: string;
  childTeam?: TeamExecutionResult;
}

export interface TeamExecutionResult {
  tasks: TeamTaskResult[];
  failed: boolean;
  conflict?: string;
}

function extractPlanText(output: string): string | undefined {
  const start = output.indexOf(TEAM_PLAN_START);
  if (start < 0) return undefined;
  const bodyStart = start + TEAM_PLAN_START.length;
  const end = output.indexOf(TEAM_PLAN_END, bodyStart);
  if (end < 0) return undefined;
  return output.slice(bodyStart, end).trim();
}

function validTask(value: unknown): value is TeamTaskDefinition {
  if (!value || typeof value !== 'object') return false;
  const task = value as Partial<TeamTaskDefinition>;
  return typeof task.id === 'string' && /^[a-zA-Z0-9_-]+$/.test(task.id) &&
    typeof task.agent === 'string' && AGENT_ORDER.includes(task.agent as typeof AGENT_ORDER[number]) &&
    Boolean(AGENT_SPECS[task.agent]) && typeof task.input === 'string' &&
    (task.dependsOn === undefined || (Array.isArray(task.dependsOn) && task.dependsOn.every(v => typeof v === 'string'))) &&
    (task.writes === undefined || typeof task.writes === 'boolean');
}

/** planner 출력에서 검증된 동적 팀 계획만 추출한다. */
export function parseTeamPlan(output: string): TeamPlan | undefined {
  const text = extractPlanText(output);
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as Partial<TeamPlan>;
    if (parsed.version !== 1 || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0 || parsed.tasks.length > MAX_TEAM_TASKS) return undefined;
    if (!parsed.tasks.every(validTask)) return undefined;
    const ids = new Set(parsed.tasks.map(task => task.id));
    if (ids.size !== parsed.tasks.length) return undefined;
    for (const task of parsed.tasks) {
      if (task.dependsOn?.some(dep => dep === task.id || !ids.has(dep))) return undefined;
    }
    // Kahn validation: cycles are invalid plans, never schedulable.
    const pending = new Set(parsed.tasks.map(task => task.id));
    let processed = 0;
    while (pending.size) {
      const ready = [...pending].filter(id => {
        const task = parsed.tasks!.find(candidate => candidate.id === id)!;
        return (task.dependsOn ?? []).every(dep => !pending.has(dep));
      });
      if (!ready.length) return undefined;
      ready.forEach(id => { pending.delete(id); processed++; });
    }
    const maxConcurrency = parsed.maxConcurrency === undefined ? DEFAULT_TEAM_CONCURRENCY : parsed.maxConcurrency;
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 16) return undefined;
    return { version: 1, tasks: parsed.tasks, maxConcurrency };
  } catch {
    return undefined;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try { await git(cwd, ['rev-parse', '--show-toplevel']); return true; } catch { return false; }
}

async function createWorktree(base: string, taskId: string): Promise<string | undefined> {
  if (!(await isGitRepo(base))) return undefined;
  const root = resolve(base, '.auto-dev-worktrees');
  await mkdir(root, { recursive: true });
  const path = join(root, `${taskId}-${randomUUID().slice(0, 8)}`);
  await git(base, ['worktree', 'add', '--detach', path, 'HEAD']);
  return path;
}

async function commitWorktree(path: string, taskId: string): Promise<string | undefined> {
  const changed = await git(path, ['status', '--porcelain']);
  if (!changed) return undefined;
  await git(path, ['add', '-A']);
  await execFileAsync('git', ['-C', path, 'commit', '-m', `team: ${taskId}`]);
  return git(path, ['rev-parse', 'HEAD']);
}

async function removeWorktree(base: string, path: string): Promise<void> {
  try {
    await execFileAsync('git', ['-C', base, 'worktree', 'remove', '--force', path]);
  } catch {
    await rm(path, { recursive: true, force: true }).catch(() => {});
  }
}

async function hasCherryPickHead(cwd: string): Promise<boolean> {
  try { await git(cwd, ['rev-parse', '--verify', 'CHERRY_PICK_HEAD']); return true; } catch { return false; }
}

export interface TeamExecutorOptions {
  cwd: string;
  input: string;
  runOpts: AgentRunOpts;
  maxDepth?: number;
  runTask?: (agent: string, input: string, opts: AgentRunOpts) => Promise<RunResult>;
}

/** 동적 팀을 실행한다. provider에 상관없이 앱 레벨에서 child run을 관리한다. */
export async function executeTeam(plan: TeamPlan, options: TeamExecutorOptions, depth = 1): Promise<TeamExecutionResult> {
  if (depth > (options.maxDepth ?? MAX_TEAM_DEPTH)) {
    return { tasks: [], failed: true, conflict: `Team depth exceeded: ${depth}` };
  }
  const runTask = options.runTask ?? ((agent, input, opts) => runNamedAgent(agent, input, opts));
  const results = new Map<string, TeamTaskResult>();
  const pending = new Set(plan.tasks.map(task => task.id));
  const worktrees = new Map<string, string>();
  const commits: string[] = [];
  let conflict: string | undefined;

  try {
    while (pending.size && !conflict) {
      const ready = plan.tasks.filter(task => pending.has(task.id) && (task.dependsOn ?? []).every(dep => results.get(dep)?.status === 'DONE'));
      const blocked = plan.tasks.find(task => pending.has(task.id) && (task.dependsOn ?? []).some(dep => results.get(dep)?.status !== 'DONE' && !pending.has(dep)));
      if (!ready.length) {
        if (blocked) {
          results.set(blocked.id, { taskId: blocked.id, agent: blocked.agent, status: 'BLOCKED', output: 'Dependency failed.' });
          pending.delete(blocked.id);
          continue;
        }
        conflict = 'No schedulable task remains; dependency graph is inconsistent.';
        break;
      }
      const batch = ready.slice(0, plan.maxConcurrency ?? DEFAULT_TEAM_CONCURRENCY);
      const batchResults = await Promise.all(batch.map(async task => {
        const base = options.cwd;
        const taskCwd = task.writes ? (await createWorktree(base, task.id)) ?? base : base;
        if (task.writes && taskCwd !== base) worktrees.set(task.id, taskCwd);
        const dependencyOutput = (task.dependsOn ?? []).map(dep => `\n\n## ${dep} 결과\n${results.get(dep)?.output ?? ''}`).join('');
        const prompt = `${options.input}\n\n## 팀 작업\n${task.input}${dependencyOutput}`;
        try {
          const run = await runTask(task.agent, prompt, { ...options.runOpts, cwd: taskCwd });
          const result: TeamTaskResult = { taskId: task.id, agent: task.agent, run, status: run.status, output: run.output, worktree: taskCwd !== base ? taskCwd : undefined };
          const childPlan = run.status === 'DONE' ? parseTeamPlan(run.output) : undefined;
          if (childPlan) {
            result.childTeam = await executeTeam(childPlan, {
              cwd: taskCwd,
              input: `${prompt}\n\n## 상위 에이전트 결과\n${run.output}`,
              runOpts: { ...options.runOpts, cwd: taskCwd },
              maxDepth: options.maxDepth,
              runTask,
            }, depth + 1);
            if (result.childTeam.failed) result.status = 'FAILED';
          }
          if (run.status === 'DONE' && taskCwd !== base) {
            const commit = await commitWorktree(taskCwd, task.id);
            if (commit) commits.push(commit);
          }
          return result;
        } catch (err) {
          return { taskId: task.id, agent: task.agent, status: 'FAILED' as const, output: '', worktree: taskCwd !== base ? taskCwd : undefined, error: err instanceof Error ? err.message : String(err) };
        }
      }));
      for (const result of batchResults) {
        results.set(result.taskId, result);
        pending.delete(result.taskId);
        if (result.status !== 'DONE') conflict ??= `Team task failed: ${result.taskId}`;
      }
    }

    // Cherry-pick is deliberately serialized: this is the single integration point.
    if (!conflict && commits.length && (await isGitRepo(options.cwd))) {
      for (const commit of commits) {
        try { await git(options.cwd, ['cherry-pick', commit]); }
        catch (err) {
          conflict = `Merge conflict for ${commit}: ${err instanceof Error ? err.message : String(err)}`;
          const integrator = await runTask(
            'integrator',
            `${options.input}\n\n## 통합 충돌\n${conflict}\n현재 worktree에서 충돌을 해결하고 테스트하세요.`,
            { ...options.runOpts, cwd: options.cwd },
          ).catch(error => ({ status: 'FAILED' as const, output: String(error), runId: '', tokensIn: 0, tokensOut: 0, durationMs: 0 }));
          if (integrator.status === 'DONE') {
            try {
              if (await hasCherryPickHead(options.cwd)) {
                await git(options.cwd, ['add', '-A']);
                await execFileAsync('git', ['-C', options.cwd, '-c', 'core.editor=true', 'cherry-pick', '--continue']);
              }
              conflict = undefined;
            } catch (integrationError) {
              conflict = `Integrator failed: ${integrationError instanceof Error ? integrationError.message : String(integrationError)}`;
            }
          }
          break;
        }
      }
    }
  } finally {
    await Promise.all([...worktrees.values()].map(path => removeWorktree(options.cwd, path)));
  }
  return { tasks: [...results.values()], failed: Boolean(conflict || [...results.values()].some(result => result.status !== 'DONE')), conflict };
}
