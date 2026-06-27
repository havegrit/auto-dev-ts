import { execCommand, type ExecCommand } from './process.js';

export interface GitStatusOutput {
  diffNameOnly: string;
  statusShort: string;
}

function statusPath(line: string): string | undefined {
  const body = line.slice(3).trim();
  if (!body) return undefined;
  const rename = body.match(/ -> (.+)$/);
  return rename ? rename[1] : body;
}

export function parseGitChangedFiles(output: GitStatusOutput): string[] {
  const files = new Set<string>();
  for (const line of output.diffNameOnly.split(/\r?\n/)) {
    const file = line.trim();
    if (file) files.add(file);
  }
  for (const line of output.statusShort.split(/\r?\n/)) {
    const file = statusPath(line);
    if (file) files.add(file);
  }
  return [...files].sort();
}

export async function collectGitChangedFiles(repoPath: string, exec: ExecCommand = execCommand): Promise<string[]> {
  const [diff, status] = await Promise.all([
    exec('git', ['diff', '--name-only'], { cwd: repoPath }),
    exec('git', ['status', '--short'], { cwd: repoPath }),
  ]);
  return parseGitChangedFiles({
    diffNameOnly: diff.stdout,
    statusShort: status.stdout,
  });
}
