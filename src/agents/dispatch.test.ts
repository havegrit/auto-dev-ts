import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { agentRun, getProviderForAgent } = vi.hoisted(() => ({
  agentRun: vi.fn(),
  getProviderForAgent: vi.fn(() => 'anthropic'),
}));

vi.mock('../lib/runner.js', () => ({
  runAgent: agentRun,
  runAgentBackground: vi.fn(),
}));

vi.mock('../lib/model-config.js', () => ({
  modelConfig: { getProviderForAgent },
}));

import { runNamedAgent } from './dispatch.js';
import { PROJECT_CONTEXT_MAX_BYTES } from './project-context.js';

const directories: string[] = [];

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'autodev-context-'));
  directories.push(dir);
  return dir;
}

function capturedOptions(): { prompt: string; subagents?: Record<string, { prompt: string }> } {
  return agentRun.mock.calls.at(-1)?.[0];
}

describe('runNamedAgent project context', () => {
  beforeEach(() => {
    agentRun.mockReset().mockResolvedValue({
      runId: 'run', output: '', tokensIn: 0, tokensOut: 0, durationMs: 0, status: 'DONE',
    });
    getProviderForAgent.mockReset().mockReturnValue('anthropic');
  });

  afterEach(() => {
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('adds AGENTS.md and feature map to target agent prompts', async () => {
    const dir = makeProject();
    mkdirSync(join(dir, '.auto-dev'));
    writeFileSync(join(dir, 'AGENTS.md'), 'repo instructions sentinel');
    writeFileSync(join(dir, '.auto-dev', 'feature-map.md'), 'service map sentinel');

    await runNamedAgent('scaffold', 'task sentinel', { cwd: dir });

    const { prompt } = capturedOptions();
    expect(prompt).toContain('## Project context');
    expect(prompt).toContain('repo instructions sentinel');
    expect(prompt).toContain('service map sentinel');
    expect(prompt).toContain('task sentinel');
  });

  it('omits the project context section when neither source file exists', async () => {
    const dir = makeProject();

    await runNamedAgent('planner', 'task sentinel', { cwd: dir });

    expect(capturedOptions().prompt).not.toContain('## Project context');
  });

  it('keeps clarifier context limited to the feature map', async () => {
    const dir = makeProject();
    mkdirSync(join(dir, '.auto-dev'));
    writeFileSync(join(dir, 'AGENTS.md'), 'instructions excluded from clarifier');
    writeFileSync(join(dir, '.auto-dev', 'feature-map.md'), 'feature map for clarifier');

    await runNamedAgent('clarifier', 'question task', { cwd: dir });

    const { prompt } = capturedOptions();
    expect(prompt).toContain('feature map for clarifier');
    expect(prompt).not.toContain('instructions excluded from clarifier');
  });

  it('truncates combined context at 16 KiB and marks it', async () => {
    const dir = makeProject();
    mkdirSync(join(dir, '.auto-dev'));
    writeFileSync(join(dir, 'AGENTS.md'), '가'.repeat(PROJECT_CONTEXT_MAX_BYTES));
    writeFileSync(join(dir, '.auto-dev', 'feature-map.md'), 'feature map tail');

    await runNamedAgent('scaffold', 'unique task marker', { cwd: dir });

    const prompt = capturedOptions().prompt;
    const contextStart = prompt.indexOf('## Project context');
    const taskStart = prompt.indexOf('unique task marker', contextStart);
    const context = prompt.slice(contextStart, taskStart).trimEnd();
    expect(context).toContain('[Project context truncated: combined files exceed 16 KiB.]');
    expect(Buffer.byteLength(context, 'utf8')).toBeLessThanOrEqual(PROJECT_CONTEXT_MAX_BYTES);
  });

  it('adds the project context to the review lenses', async () => {
    const dir = makeProject();
    mkdirSync(join(dir, '.auto-dev'));
    writeFileSync(join(dir, 'AGENTS.md'), 'review rules sentinel');
    writeFileSync(join(dir, '.auto-dev', 'feature-map.md'), 'review map sentinel');

    await runNamedAgent('review', 'review task sentinel', { cwd: dir });

    const options = capturedOptions();
    expect(options.prompt).toContain('review rules sentinel');
    expect(Object.values(options.subagents ?? {})).toHaveLength(4);
    for (const lens of Object.values(options.subagents ?? {})) {
      expect(lens.prompt).toContain('review rules sentinel');
      expect(lens.prompt).toContain('review map sentinel');
    }
  });

  it('uses SDK-loaded CLAUDE.md without repeating it in Anthropic prompts', async () => {
    const dir = makeProject();
    writeFileSync(join(dir, 'CLAUDE.md'), 'claude instructions sentinel');
    getProviderForAgent.mockReturnValue('anthropic');

    await runNamedAgent('planner', 'task sentinel', { cwd: dir });

    expect(capturedOptions().prompt).not.toContain('claude instructions sentinel');
  });

  it('injects CLAUDE.md when the selected provider does not load it', async () => {
    const dir = makeProject();
    writeFileSync(join(dir, 'CLAUDE.md'), 'claude instructions sentinel');
    getProviderForAgent.mockReturnValue('codex-cli');

    await runNamedAgent('planner', 'task sentinel', { cwd: dir });

    expect(capturedOptions().prompt).toContain('claude instructions sentinel');
  });
});
