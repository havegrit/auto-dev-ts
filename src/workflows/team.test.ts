import { describe, expect, it, vi } from 'vitest';
import { executeTeam, parseTeamPlan, type TeamPlan } from './team.js';

describe('dynamic team plans', () => {
  it('parses and validates a machine-readable DAG', () => {
    const plan = parseTeamPlan(`TEAM_PLAN:\n${JSON.stringify({
      version: 1,
      tasks: [
        { id: 'api', agent: 'scaffold', input: 'API 구현', writes: true },
        { id: 'ui', agent: 'scaffold', input: 'UI 구현', writes: true },
        { id: 'review', agent: 'review', input: '검토', dependsOn: ['api', 'ui'] },
      ],
    })}\nEND_TEAM_PLAN.`);
    expect(plan?.tasks.map(task => task.id)).toEqual(['api', 'ui', 'review']);
    expect(parseTeamPlan('TEAM_PLAN: {"version":1,"tasks":[{"id":"a","agent":"scaffold","input":"x","dependsOn":["b"]},{"id":"b","agent":"test","input":"x","dependsOn":["a"]}]} END_TEAM_PLAN.')).toBeUndefined();
  });

  it('runs independent tasks in parallel and dependencies afterward', async () => {
    const order: string[] = [];
    const plan: TeamPlan = {
      version: 1,
      maxConcurrency: 2,
      tasks: [
        { id: 'a', agent: 'scaffold', input: 'a' },
        { id: 'b', agent: 'test', input: 'b' },
        { id: 'c', agent: 'review', input: 'c', dependsOn: ['a', 'b'] },
      ],
    };
    const result = await executeTeam(plan, {
      cwd: '/tmp',
      input: 'base',
      runOpts: {},
      runTask: vi.fn(async (agent) => {
        order.push(`start:${agent}`);
        await new Promise(resolve => setTimeout(resolve, 5));
        order.push(`end:${agent}`);
        return { runId: agent, output: agent, tokensIn: 0, tokensOut: 0, durationMs: 5, status: 'DONE' as const };
      }),
    });
    expect(result.failed).toBe(false);
    expect(order.slice(0, 2)).toEqual(['start:scaffold', 'start:test']);
    expect(order[2]).toBe('end:scaffold');
    expect(order[3]).toBe('end:test');
    expect(order[4]).toBe('start:review');
  });
});
