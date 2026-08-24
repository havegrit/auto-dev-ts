import { mkdtemp, mkdir, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ workspace: '' }));
const completeMock = vi.hoisted(() => vi.fn());

vi.mock('./workspace.js', () => ({
  resolveProjectDir: (project = '') => resolve(state.workspace, project),
}));
vi.mock('./complete.js', () => ({
  complete: completeMock,
  parseJsonLoose: (text: string) => JSON.parse(text),
}));

import { buildProjectChatContext, isSensitiveChatPath } from './chat-context.js';

beforeEach(async () => {
  state.workspace = await mkdtemp(join(tmpdir(), 'auto-dev-chat-'));
  completeMock.mockReset();
  completeMock.mockResolvedValue('{"paths":[]}');
});

describe('project chat context', () => {
  it('reads only safe text files and follows internal symlinks', async () => {
    const project = join(state.workspace, 'demo');
    await mkdir(join(project, 'src'), { recursive: true });
    await mkdir(join(project, 'node_modules/pkg'), { recursive: true });
    await writeFile(join(project, 'README.md'), '# Demo\nserver routing');
    await writeFile(join(project, 'src/server.ts'), 'export function serverRouting() {}');
    await writeFile(join(project, '.env'), 'TOKEN=hidden');
    await writeFile(join(project, 'auth-token.txt'), 'hidden');
    await writeFile(join(project, 'node_modules/pkg/index.js'), 'hidden dependency');
    await writeFile(join(project, 'image.png'), Buffer.from([0, 1, 2, 3]));
    await symlink(join(project, 'src/server.ts'), join(project, 'server-link.ts'));

    const result = await buildProjectChatContext('demo', 'server routing은 어디에 있나?');

    expect(result.files).toContain('README.md');
    expect(result.files.some((path) => path === 'src/server.ts' || path === 'server-link.ts')).toBe(true);
    expect(result.text).not.toContain('TOKEN=hidden');
    expect(result.text).not.toContain('hidden dependency');
    expect(result.text).not.toContain('image.png');
  });

  it('uses model-selected paths when lexical relevance is low', async () => {
    const project = join(state.workspace, 'demo');
    await mkdir(join(project, 'docs'), { recursive: true });
    await writeFile(join(project, 'README.md'), '# Demo');
    await writeFile(join(project, 'docs/design.md'), 'bounded context design');
    completeMock.mockResolvedValue('{"paths":["docs/design.md","../outside.txt",".env"]}');

    const result = await buildProjectChatContext('demo', '이것을 자세히 설명해줘', 'model');

    expect(result.usedHybridSelection).toBe(true);
    expect(completeMock).toHaveBeenCalledOnce();
    expect(result.files).toContain('docs/design.md');
    expect(result.files).not.toContain('../outside.txt');
  });

  it('rejects a project symlink that escapes the workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'auto-dev-outside-'));
    await writeFile(join(outside, 'README.md'), '# Outside');
    await symlink(outside, join(state.workspace, 'escaped'));

    await expect(buildProjectChatContext('escaped', 'read')).rejects.toThrow(/Invalid or missing project/);
  });

  it('classifies credentials and certificate paths as sensitive', () => {
    expect(isSensitiveChatPath('.env.local')).toBe(true);
    expect(isSensitiveChatPath('.envrc')).toBe(true);
    expect(isSensitiveChatPath('.npmrc')).toBe(true);
    expect(isSensitiveChatPath('.ssh/id_ed25519')).toBe(true);
    expect(isSensitiveChatPath('config/client.pem')).toBe(true);
    expect(isSensitiveChatPath('config/api-credential.json')).toBe(true);
    expect(isSensitiveChatPath('src/tokenizer.ts')).toBe(false);
  });
});
