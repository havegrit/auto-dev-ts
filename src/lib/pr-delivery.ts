import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DeliveryConfig } from './project-config.js';

export type PullRequestDeliveryStage = 'docs-audit' | 'commit' | 'push' | 'pull-request';
export type PullRequestDeliveryStatus = 'READY' | 'DELIVERY_PENDING' | 'NO_CHANGES' | 'DELIVERED';

export interface PullRequestDeliveryState {
  status: PullRequestDeliveryStatus;
  stage?: PullRequestDeliveryStage;
  commitSha?: string;
  prNumber?: number;
  prUrl?: string;
  reason?: string;
}

/** 체크포인트와 clarification 상태에 저장할 PR 실행 정보. */
export interface PullRequestDeliveryContext {
  workflowRunId: string;
  /** clarification으로 workflow run ID가 바뀌어도 PR 링크는 현재 실행을 가리킨다. */
  dashboardRunId?: string;
  sourceDir: string;
  worktreeDir: string;
  remote: string;
  repository: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  publicBaseUrl: string;
  accessControl: 'authenticated' | 'network-restricted';
  state?: PullRequestDeliveryState;
}

export interface PullRequestDescription {
  requestSummary: string;
  verifyCommand?: string;
  verifyConfigured?: boolean;
  verifyDurationMs?: number;
  verifySummary: string;
  reviewSummary: string;
}

interface DeliveryEnvironment {
  AUTO_DEV_PUBLIC_BASE_URL?: string;
  AUTO_DEV_PUBLIC_ACCESS_CONTROL?: string;
}

interface DeliveryDependencies {
  run(command: 'git' | 'gh', args: string[], cwd: string): string;
  exists(path: string): boolean;
  mkdir(path: string): void;
  worktreeRoot: string;
}

const defaultDependencies: DeliveryDependencies = {
  run(command, args, cwd) {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    }).trim();
  },
  exists: existsSync,
  mkdir(path) { mkdirSync(path, { recursive: true }); },
  worktreeRoot: resolve('data/worktrees'),
};

function publicLinkConfig(env: DeliveryEnvironment): Pick<PullRequestDeliveryContext, 'publicBaseUrl' | 'accessControl'> {
  const raw = env.AUTO_DEV_PUBLIC_BASE_URL?.trim();
  if (!raw) throw new Error('PR delivery requires AUTO_DEV_PUBLIC_BASE_URL with an HTTPS dashboard URL.');
  let url: URL;
  try { url = new URL(raw); } catch {
    throw new Error('AUTO_DEV_PUBLIC_BASE_URL must be a valid HTTPS URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('AUTO_DEV_PUBLIC_BASE_URL must be HTTPS and must not include credentials, query, or fragment.');
  }
  const accessControl = env.AUTO_DEV_PUBLIC_ACCESS_CONTROL?.trim();
  if (accessControl !== 'authenticated' && accessControl !== 'network-restricted') {
    throw new Error('PR delivery requires AUTO_DEV_PUBLIC_ACCESS_CONTROL=authenticated or network-restricted after the external proxy is configured.');
  }
  return { publicBaseUrl: url.toString().replace(/\/$/, ''), accessControl };
}

function repositoryFromRemote(remoteUrl: string): string {
  const value = remoteUrl.trim();
  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error('PR delivery requires a valid GitHub origin remote.'); }
    if (url.hostname.toLowerCase() !== 'github.com' || url.username || url.password) {
      throw new Error('PR delivery requires a credential-free GitHub origin remote.');
    }
    const path = url.pathname.replace(/^\//, '').replace(/\.git$/, '');
    if (!/^[^/]+\/[^/]+$/.test(path)) throw new Error('PR delivery requires a GitHub origin with owner/repository.');
    return path;
  }
  if (/^ssh:\/\//i.test(value)) {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error('PR delivery requires a valid GitHub origin remote.'); }
    if (url.hostname.toLowerCase() !== 'github.com' || url.password) {
      throw new Error('PR delivery requires a credential-free GitHub origin remote.');
    }
    const path = url.pathname.replace(/^\//, '').replace(/\.git$/, '');
    if (!/^[^/]+\/[^/]+$/.test(path)) throw new Error('PR delivery requires a GitHub origin with owner/repository.');
    return path;
  }
  const match = value.match(/(?:github\.com[:/])([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (!match) throw new Error('PR delivery requires an origin remote hosted on github.com.');
  return match[1];
}

function commandError(err: unknown, command: string): Error {
  const detail = err instanceof Error ? err.message.replace(/\s+/g, ' ').slice(0, 500) : String(err).slice(0, 500);
  return new Error(`${command} failed: ${detail}`);
}

/** GitHub/gh/public-link 검사를 끝낸 뒤 원격 base SHA에서 run 전용 worktree를 만든다. */
export function preparePullRequestWorktree(
  sourceDir: string,
  workflowRunId: string,
  config: DeliveryConfig,
  env: DeliveryEnvironment = process.env,
  dependencies: DeliveryDependencies = defaultDependencies,
): PullRequestDeliveryContext {
  if (config.mode !== 'pull-request') throw new Error('preparePullRequestWorktree requires delivery.mode=pull-request.');
  const publicLink = publicLinkConfig(env);
  if (!/^[a-f0-9-]{8,}$/i.test(workflowRunId)) throw new Error('Invalid workflow run ID for PR delivery.');

  let remoteUrl: string;
  try { remoteUrl = dependencies.run('git', ['remote', 'get-url', 'origin'], sourceDir); } catch (err) {
    throw commandError(err, 'GitHub origin lookup');
  }
  const repository = repositoryFromRemote(remoteUrl);
  try { dependencies.run('gh', ['auth', 'status'], sourceDir); } catch (err) {
    throw commandError(err, 'GitHub CLI authentication check (run `gh auth login`)');
  }

  let repositoryInfo: { nameWithOwner?: string; defaultBranchRef?: { name?: string } };
  try {
    repositoryInfo = JSON.parse(dependencies.run('gh', ['repo', 'view', '--repo', repository, '--json', 'nameWithOwner,defaultBranchRef'], sourceDir)) as typeof repositoryInfo;
  } catch (err) {
    throw commandError(err, 'GitHub repository access check');
  }
  if (repositoryInfo.nameWithOwner?.toLowerCase() !== repository.toLowerCase()) {
    throw new Error(`GitHub repository identity does not match origin (${repository}).`);
  }
  const baseBranch = config.baseBranch ?? repositoryInfo.defaultBranchRef?.name;
  if (!baseBranch) throw new Error(`Could not determine the default branch for ${repository}.`);
  try { dependencies.run('git', ['check-ref-format', '--branch', baseBranch], sourceDir); } catch (err) {
    throw commandError(err, `Invalid PR base branch (${baseBranch})`);
  }

  const remote = 'origin';
  const remoteRef = `refs/remotes/${remote}/${baseBranch}`;
  try {
    dependencies.run('git', ['fetch', remote, `refs/heads/${baseBranch}:${remoteRef}`], sourceDir);
  } catch (err) {
    throw commandError(err, `Fetch PR base branch (${baseBranch})`);
  }
  let baseSha: string;
  try { baseSha = dependencies.run('git', ['rev-parse', `${remoteRef}^{commit}`], sourceDir); } catch (err) {
    throw commandError(err, `Resolve PR base branch (${baseBranch})`);
  }

  const worktreeDir = resolve(dependencies.worktreeRoot, workflowRunId);
  if (dependencies.exists(worktreeDir)) throw new Error(`PR worktree path already exists: ${worktreeDir}`);
  dependencies.mkdir(dirname(worktreeDir));
  const branch = `autodev/${workflowRunId.slice(0, 8)}`;
  try {
    dependencies.run('git', ['check-ref-format', '--branch', branch], sourceDir);
    dependencies.run('git', ['worktree', 'add', '-b', branch, worktreeDir, baseSha], sourceDir);
  } catch (err) {
    throw commandError(err, `Create PR worktree (${branch})`);
  }

  return {
    workflowRunId,
    sourceDir: resolve(sourceDir),
    worktreeDir,
    remote,
    repository,
    branch,
    baseBranch,
    baseSha,
    ...publicLink,
    state: { status: 'READY' },
  };
}

/** clarification 재개 전에도 GitHub 인증, base ref, worktree branch를 다시 확인한다. */
export function validatePullRequestDeliveryContext(
  context: PullRequestDeliveryContext,
  env: DeliveryEnvironment = process.env,
  dependencies: Pick<DeliveryDependencies, 'run'> = defaultDependencies,
): void {
  const publicLink = publicLinkConfig(env);
  if (publicLink.publicBaseUrl !== context.publicBaseUrl || publicLink.accessControl !== context.accessControl) {
    throw new Error('PR dashboard URL or external access-control setting changed during the workflow.');
  }
  const remoteUrl = dependencies.run('git', ['remote', 'get-url', context.remote], context.sourceDir);
  if (repositoryFromRemote(remoteUrl).toLowerCase() !== context.repository.toLowerCase()) {
    throw new Error('The GitHub remote changed during the PR workflow.');
  }
  try { dependencies.run('gh', ['auth', 'status'], context.worktreeDir); } catch (err) {
    throw commandError(err, 'GitHub CLI authentication check (run `gh auth login`)');
  }
  const info = JSON.parse(dependencies.run('gh', [
    'repo', 'view', '--repo', context.repository, '--json', 'nameWithOwner,defaultBranchRef',
  ], context.worktreeDir)) as { nameWithOwner?: string };
  if (info.nameWithOwner?.toLowerCase() !== context.repository.toLowerCase()) {
    throw new Error(`GitHub repository identity changed during the PR workflow (${context.repository}).`);
  }
  dependencies.run('git', ['fetch', context.remote, `refs/heads/${context.baseBranch}:refs/remotes/${context.remote}/${context.baseBranch}`], context.sourceDir);
  const currentBase = dependencies.run('git', ['rev-parse', `refs/remotes/${context.remote}/${context.baseBranch}^{commit}`], context.sourceDir);
  if (currentBase !== context.baseSha) throw new Error(`PR base branch ${context.baseBranch} moved since this run started.`);
  const currentBranch = dependencies.run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], context.worktreeDir);
  if (currentBranch !== context.branch) throw new Error(`PR worktree is on ${currentBranch}, expected ${context.branch}.`);
}

function cleanSummary(value: string, limit = 180): string {
  return value
    .split(/\r?\n/).map(line => line.trim()).find(Boolean)
    ?.replace(/^#+\s*/, '')
    .replace(/(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/https?:\/\/\S+/gi, '[URL redacted]')
    .replace(/[<>`]/g, '')
    .slice(0, limit) || 'Implementation completed';
}

function buildPullRequestBody(context: PullRequestDeliveryContext, description: PullRequestDescription, headSha: string): string {
  const runUrl = `${context.publicBaseUrl}/?run=${encodeURIComponent(context.dashboardRunId ?? context.workflowRunId)}`;
  return [
    '## Summary',
    `- ${cleanSummary(description.requestSummary)}`,
    '',
    '## Delivery',
    `- Head: \`${headSha}\``,
    `- Base: \`${context.baseSha}\` (${context.baseBranch})`,
    '',
    '## Verification',
    `- Command: ${cleanSummary(description.verifyCommand || '(not configured)', 300)}`,
    `- Result: ${description.verifyConfigured
      ? `PASS (exit code 0${description.verifyDurationMs === undefined ? '' : `, ${description.verifyDurationMs}ms`})`
      : 'NOT CONFIGURED'}`,
    `- Runtime checks: ${cleanSummary(description.verifySummary, 300)}`,
    `- Review: ${cleanSummary(description.reviewSummary)}`,
    '',
    '## Run details',
    `- [Open workflow run](${runUrl})`,
  ].join('\n');
}

function parseJsonList<T>(output: string, command: string): T[] {
  try {
    const value: unknown = JSON.parse(output);
    if (!Array.isArray(value)) throw new Error('expected a JSON array');
    return value as T[];
  } catch (err) {
    throw new Error(`${command} returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function completePullRequestDelivery(
  context: PullRequestDeliveryContext,
  description: PullRequestDescription,
  onStage: (stage: PullRequestDeliveryStage, state: PullRequestDeliveryState) => void | Promise<void> = () => {},
  dependencies: Pick<DeliveryDependencies, 'run'> = defaultDependencies,
): Promise<PullRequestDeliveryState> {
  const publish = async (state: PullRequestDeliveryState): Promise<void> => {
    context.state = state;
    await onStage(state.stage ?? 'commit', state);
  };
  const runGit = (args: string[]) => dependencies.run('git', args, context.worktreeDir);
  const marker = `Auto-Dev-Run: ${context.workflowRunId}`;
  let commitSha = context.state?.commitSha;
  await publish({ status: 'READY', stage: 'commit', ...(commitSha ? { commitSha } : {}) });

  const head = runGit(['rev-parse', 'HEAD']);
  const porcelain = runGit(['status', '--porcelain=v1', '--untracked-files=all']);
  if (commitSha && (head !== commitSha || porcelain)) {
    throw new Error('PR worktree changed after its verified commit; automatic delivery stopped for manual review.');
  }
  if (!commitSha && head !== context.baseSha) {
    const parent = runGit(['rev-parse', 'HEAD^']);
    const message = runGit(['log', '-1', '--format=%B']);
    if (parent !== context.baseSha || !message.includes(marker)) {
      throw new Error('PR worktree contains an unexpected commit; automatic delivery stopped without rewriting it.');
    }
    commitSha = head;
  }
  if (!commitSha && !porcelain) {
    const noChanges: PullRequestDeliveryState = { status: 'NO_CHANGES', stage: 'commit' };
    await publish(noChanges);
    return noChanges;
  }
  if (!commitSha) {
    await publish({ status: 'READY', stage: 'commit' });
    runGit(['add', '--all']);
    runGit([
      '-c', 'user.name=auto-dev', '-c', 'user.email=auto-dev@users.noreply.github.com',
      'commit', '-m', `feat: auto-dev run ${context.workflowRunId.slice(0, 8)}`, '-m', marker,
    ]);
    commitSha = runGit(['rev-parse', 'HEAD']);
    const parent = runGit(['rev-parse', 'HEAD^']);
    if (parent !== context.baseSha) throw new Error('PR commit is not directly based on the recorded base SHA.');
  }
  await publish({ status: 'READY', stage: 'push', commitSha });

  const remoteRef = `refs/heads/${context.branch}`;
  const remoteLine = runGit(['ls-remote', context.remote, remoteRef]);
  const remoteSha = remoteLine.split(/\s+/)[0];
  if (remoteSha && remoteSha !== commitSha) {
    throw new Error(`Remote branch ${context.branch} already points to ${remoteSha}; expected ${commitSha}. Force push is disabled.`);
  }
  if (!remoteSha) runGit(['push', context.remote, `HEAD:${remoteRef}`]);
  await publish({ status: 'READY', stage: 'pull-request', commitSha });

  const queryArgs = ['pr', 'list', '--repo', context.repository, '--head', context.branch, '--base', context.baseBranch,
    '--state', 'all', '--json', 'number,url,headRefOid,headRefName,baseRefName,state'];
  type PullRequestRecord = {
    number?: number; url?: string; headRefOid?: string; headRefName?: string; baseRefName?: string; state?: string;
  };
  const existing = parseJsonList<PullRequestRecord>(dependencies.run('gh', queryArgs, context.worktreeDir), 'gh pr list');
  let pr = existing.find(entry => entry.headRefName === context.branch && entry.baseRefName === context.baseBranch);
  if (pr) {
    if (pr.headRefOid !== commitSha || !pr.url || typeof pr.number !== 'number') {
      throw new Error(`An open PR for ${context.branch} exists with a different head; automatic update is disabled.`);
    }
  } else {
    const title = `auto-dev: ${cleanSummary(description.requestSummary)}`.slice(0, 240);
    const body = buildPullRequestBody(context, description, commitSha);
    const url = dependencies.run('gh', [
      'pr', 'create', '--repo', context.repository, '--head', context.branch, '--base', context.baseBranch,
      '--title', title, '--body', body,
    ], context.worktreeDir).split(/\s+/).find(part => part.startsWith('https://github.com/'));
    if (!url) throw new Error('gh pr create completed without returning a GitHub PR URL.');
    const viewed = JSON.parse(dependencies.run('gh', ['pr', 'view', '--repo', context.repository, url,
      '--json', 'number,url,headRefOid,headRefName,baseRefName,state'], context.worktreeDir)) as PullRequestRecord;
    if (viewed.headRefOid !== commitSha || viewed.headRefName !== context.branch || viewed.baseRefName !== context.baseBranch) {
      throw new Error('Created PR does not match the verified head and base; delivery requires manual recovery.');
    }
    pr = viewed;
  }
  if (!pr) throw new Error('GitHub PR lookup completed without a result.');

  const delivered: PullRequestDeliveryState = {
    status: 'DELIVERED', stage: 'pull-request', commitSha, prNumber: pr.number, prUrl: pr.url,
  };
  await publish(delivered);
  return delivered;
}
