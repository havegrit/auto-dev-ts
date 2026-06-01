import { scaffold } from './scaffold.js';
import { review } from './review/index.js';
import { test } from './test.js';
import { cicd } from './cicd.js';
import { planner } from './planner.js';
import { clarifier } from './clarifier.js';
import type { RunResult } from '../lib/runner.js';

type AgentFn = (input: string, opts?: Record<string, string>) => Promise<RunResult>;

const registry: Record<string, AgentFn> = { scaffold, review, test, cicd, planner, clarifier };

export function getAgent(name: string): AgentFn | undefined { return registry[name]; }
export function listAgents(): string[] { return Object.keys(registry); }
