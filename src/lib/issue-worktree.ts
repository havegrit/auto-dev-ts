import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';

const execFileAsync = promisify(execFile);

export interface IssueWorktreeContext {
  sourceDir: string;
  worktreeDir: string;
  remote: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  workflowRunId: string;
  issueKey: string;
}

export interface IssueGitDependencies {
  run(command: string, args: string[], cwd: string): Promise<string>;
  mkdir(path: string): Promise<void>;
  worktreeRoot: string;
}

const defaultDependencies: IssueGitDependencies = {
  async run(command, args, cwd) {
    const { stdout } = await execFileAsync(command, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    });
    return stdout.trim();
  },
  mkdir(path) { return mkdir(path, { recursive: true }).then(() => {}); },
  worktreeRoot: resolve(process.env.AUTO_DEV_PLANE_WORKTREE_ROOT ?? 'data/worktrees/issues'),
};

async function git(dependencies: IssueGitDependencies, cwd: string, args: string[]): Promise<string> {
  return dependencies.run('git', args, cwd);
}

function cleanIssueKey(issueKey: string): string {
  return issueKey.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'issue';
}

async function discoverDefaultBranch(sourceDir: string, dependencies: IssueGitDependencies): Promise<string> {
  const symbolic = await git(dependencies, sourceDir, ['ls-remote', '--symref', 'origin', 'HEAD']);
  const match = symbolic.match(/^ref:\s+refs\/heads\/(.+?)\s+HEAD$/m);
  if (!match) throw new Error('Could not resolve origin default branch. Set delivery.baseBranch in the project config.');
  return match[1];
}

export async function prepareIssueWorktree(
  sourceDir: string,
  workflowRunId: string,
  issueKey: string,
  baseBranchOverride?: string,
  dependencies: IssueGitDependencies = defaultDependencies,
): Promise<IssueWorktreeContext> {
  const source = resolve(sourceDir);
  const topLevel = await git(dependencies, source, ['rev-parse', '--show-toplevel']);
  if (resolve(topLevel) !== source) throw new Error(`Issue project path must be the Git repository root: ${source}`);
  await git(dependencies, source, ['remote', 'get-url', 'origin']);

  const baseBranch = baseBranchOverride?.trim() || await discoverDefaultBranch(source, dependencies);
  await git(dependencies, source, ['check-ref-format', '--branch', baseBranch]);
  const refspec = `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`;
  let fetchError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await git(dependencies, source, ['fetch', 'origin', refspec]);
      fetchError = undefined;
      break;
    } catch (err) {
      fetchError = err;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200 * (attempt + 1)));
    }
  }
  if (fetchError) throw new Error(`Failed to fetch origin/${baseBranch}: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`);
  const baseSha = await git(dependencies, source, ['rev-parse', `refs/remotes/origin/${baseBranch}^{commit}`]);

  const shortRunId = workflowRunId.replace(/[^a-f0-9]/gi, '').slice(0, 8).toLowerCase();
  if (shortRunId.length < 8) throw new Error('Invalid workflow run ID for issue worktree');
  const branch = `autodev/issue/${cleanIssueKey(issueKey)}-${shortRunId}`;
  await git(dependencies, source, ['check-ref-format', '--branch', branch]);
  const worktreeDir = resolve(dependencies.worktreeRoot, workflowRunId);
  await dependencies.mkdir(dirname(worktreeDir));
  await git(dependencies, source, ['worktree', 'add', '-b', branch, worktreeDir, baseSha]);

  return {
    sourceDir: source,
    worktreeDir,
    remote: 'origin',
    branch,
    baseBranch,
    baseSha,
    workflowRunId,
    issueKey,
  };
}

export async function currentIssueWorktreeSha(
  context: IssueWorktreeContext,
  dependencies: IssueGitDependencies = defaultDependencies,
): Promise<string> {
  return git(dependencies, context.worktreeDir, ['rev-parse', 'HEAD']);
}

export async function issueWorktreeStatus(
  context: IssueWorktreeContext,
  dependencies: IssueGitDependencies = defaultDependencies,
): Promise<string> {
  return git(dependencies, context.worktreeDir, ['status', '--porcelain=v1', '--untracked-files=all']);
}

export async function issueWorktreeCheckpoint(
  context: IssueWorktreeContext,
  dependencies: IssueGitDependencies = defaultDependencies,
): Promise<{ headSha: string; changedPaths: string[] }> {
  const [headSha, status] = await Promise.all([
    currentIssueWorktreeSha(context, dependencies),
    issueWorktreeStatus(context, dependencies),
  ]);
  return {
    headSha,
    changedPaths: status.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3)).slice(0, 40),
  };
}

export async function commitIssueWorktree(
  context: IssueWorktreeContext,
  kind: 'success' | 'wip',
  details: string,
  dependencies: IssueGitDependencies = defaultDependencies,
): Promise<string | undefined> {
  const status = await issueWorktreeStatus(context, dependencies);
  const head = await currentIssueWorktreeSha(context, dependencies);
  if (!status) return head;
  await git(dependencies, context.worktreeDir, ['add', '--all']);
  const subject = kind === 'wip'
    ? `wip: auto-dev ${context.issueKey}`
    : `feat: auto-dev ${context.issueKey}`;
  await dependencies.run('git', [
    '-c', 'user.name=auto-dev', '-c', 'user.email=auto-dev@users.noreply.github.com',
    'commit', '-m', subject, '-m', `Auto-Dev-Run: ${context.workflowRunId}`, '-m', details.slice(0, 4_000),
  ], context.worktreeDir);
  return currentIssueWorktreeSha(context, dependencies);
}

export async function pushIssueWorktree(
  context: IssueWorktreeContext,
  expectedSha: string,
  dependencies: IssueGitDependencies = defaultDependencies,
): Promise<void> {
  const remoteRef = `refs/heads/${context.branch}`;
  const readRemoteSha = async (): Promise<string | undefined> => {
    const line = await git(dependencies, context.worktreeDir, ['ls-remote', context.remote, remoteRef]);
    const sha = line.split(/\s+/)[0];
    return /^[a-f0-9]{40,64}$/i.test(sha ?? '') ? sha : undefined;
  };

  const existingSha = await readRemoteSha();
  if (existingSha && existingSha !== expectedSha) {
    throw new Error(`Remote branch ${context.branch} already points to ${existingSha}; force push is disabled.`);
  }
  if (!existingSha) {
    await git(dependencies, context.worktreeDir, ['push', context.remote, `HEAD:${remoteRef}`]);
  }
  const verifiedSha = await readRemoteSha();
  if (verifiedSha !== expectedSha) {
    throw new Error(`Remote branch ${context.branch} does not point to expected commit ${expectedSha}.`);
  }
}

export async function removePushedIssueWorktree(
  context: IssueWorktreeContext,
  expectedSha: string,
  dependencies: IssueGitDependencies = defaultDependencies,
): Promise<void> {
  await pushIssueWorktree(context, expectedSha, dependencies);
  const currentBranch = await git(dependencies, context.worktreeDir, ['branch', '--show-current']);
  if (currentBranch !== context.branch) throw new Error(`Issue worktree moved to unexpected branch ${currentBranch}.`);
  const status = await issueWorktreeStatus(context, dependencies);
  if (status) throw new Error('Issue worktree contains uncommitted changes; cleanup stopped.');
  await git(dependencies, context.sourceDir, ['worktree', 'remove', context.worktreeDir]);
  await git(dependencies, context.sourceDir, ['branch', '-D', context.branch]);
}

export async function remoteIssueBranchSha(
  context: IssueWorktreeContext,
  dependencies: IssueGitDependencies = defaultDependencies,
): Promise<string | undefined> {
  const line = await git(dependencies, context.sourceDir, ['ls-remote', context.remote, `refs/heads/${context.branch}`]);
  const sha = line.split(/\s+/)[0];
  return /^[a-f0-9]{40,64}$/i.test(sha ?? '') ? sha : undefined;
}
