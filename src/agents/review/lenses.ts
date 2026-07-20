import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

export const LENSES: Record<string, AgentDefinition> = {
  correctness: {
    description: 'Review code correctness, logic errors, and edge cases. Report findings with severity (BLOCKER/HIGH/MEDIUM/LOW), file, and line.',
    prompt: 'You are a code correctness reviewer. Find logic errors, missing edge cases, and bugs. Report each finding with BLOCKER/HIGH/MEDIUM/LOW severity, file name, and line number.',
  },
  security: {
    description: 'Review security vulnerabilities (injection, authentication, exposed secrets, etc.). Report findings with severity (BLOCKER/HIGH/MEDIUM/LOW), file, and line.',
    prompt: 'You are a security reviewer. Check for SQL/command injection, authentication and authorization flaws, exposed secrets, and OWASP Top 10 issues. Report each finding with BLOCKER/HIGH/MEDIUM/LOW severity, file name, and line number.',
  },
  perf: {
    description: 'Review performance bottlenecks, inefficient queries, and memory leaks. Report findings with severity (BLOCKER/HIGH/MEDIUM/LOW), file, and line.',
    prompt: 'You are a performance reviewer. Find N+1 queries, unnecessary loops, memory leaks, and blocking I/O. Report each finding with BLOCKER/HIGH/MEDIUM/LOW severity, file name, and line number.',
  },
  style: {
    description: 'Review code style, readability, naming, and documentation. Report findings with MEDIUM/LOW severity, file, and line.',
    prompt: 'You are a code style reviewer. Check naming, readability, duplication, and missing comments or documentation. Report each finding with MEDIUM/LOW severity, file name, and line number.',
  },
};
