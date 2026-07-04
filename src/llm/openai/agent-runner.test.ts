import { describe, it, expect } from 'vitest';
import { openaiAgentRunner } from './agent-runner.js';

describe('openaiAgentRunner', () => {
  it('throws because tool-using agent runs are not supported yet', async () => {
    await expect(
      openaiAgentRunner.run(
        { prompt: 'x', cwd: '/tmp', tools: ['Read'], model: 'm' },
        () => {},
      ),
    ).rejects.toThrow(/does not support tool-using agent runs/);
  });
});
