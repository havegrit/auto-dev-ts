import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

function skillRoots(): string[] {
  const configured = process.env.AUTO_DEV_SKILLS_ROOT?.trim();
  return [
    ...(configured ? [configured] : []),
    join(homedir(), '.codex', 'skills'),
    join(homedir(), '.claude', 'skills'),
  ];
}

/** Load the exact globally installed skill instructions for provider-independent agent use. */
export function loadGlobalSkill(name: string): string {
  for (const root of skillRoots()) {
    const path = join(root, name, 'SKILL.md');
    if (existsSync(path)) return readFileSync(path, 'utf8');
  }
  throw new Error(`Global skill not found: ${name}`);
}
