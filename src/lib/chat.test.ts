import { beforeEach, describe, expect, it, vi } from 'vitest';

const buildContextMock = vi.hoisted(() => vi.fn());
const completeMock = vi.hoisted(() => vi.fn());
vi.mock('./chat-context.js', () => ({ buildProjectChatContext: buildContextMock }));
vi.mock('./complete.js', () => ({ complete: completeMock }));

import { parseChatMemoryRequest, parseChatRequest, prepareChat, summarizeChatMemory } from './chat.js';

beforeEach(() => {
  vi.clearAllMocks();
  buildContextMock.mockResolvedValue({ text: 'project files', files: ['README.md'], usedHybridSelection: false });
  completeMock.mockResolvedValue('## 결정\n- dark mode');
});

describe('chat request', () => {
  it('requires a project and a trailing user message in project mode', () => {
    expect(() => parseChatRequest({ mode: 'project', messages: [{ role: 'user', content: 'hi' }] })).toThrow(/project is required/);
    expect(() => parseChatRequest({ mode: 'general', messages: [{ role: 'assistant', content: 'hi' }] })).toThrow(/last message/);
  });

  it('builds a read-only prompt with project context and memory', async () => {
    const body = parseChatRequest({
      mode: 'project', project: 'demo', model: 'anthropic:m', memory: '## UI\n- dark',
      messages: [{ role: 'user', content: '구조 알려줘' }],
    });
    const prepared = await prepareChat(body);
    expect(buildContextMock).toHaveBeenCalledWith('demo', '구조 알려줘', 'anthropic:m', undefined);
    expect(prepared.system).toContain('파일 수정');
    expect(prepared.message).toContain('project files');
    expect(prepared.message).toContain('## UI');
  });

  it('validates memory requests without requiring a final user message', () => {
    const parsed = parseChatMemoryRequest({ messages: [{ role: 'assistant', content: 'answer' }] });
    expect(parsed.messages).toEqual([{ role: 'assistant', content: 'answer' }]);
  });

  it('merges durable memory through a tool-free completion', async () => {
    const memory = await summarizeChatMemory({
      existingMemory: '## old', model: 'm', messages: [{ role: 'user', content: '다크 모드 선호' }],
    });
    expect(memory).toContain('dark mode');
    expect(completeMock).toHaveBeenCalledWith(expect.objectContaining({ model: 'm' }));
  });
});
