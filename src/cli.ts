import './env.js'; // 반드시 첫 번째 — 다른 모듈이 import 시점에 env를 읽기 전에 .env를 로드한다
import { Command } from 'commander';
import { readFileSync, existsSync } from 'fs';
import { scaffold } from './agents/scaffold.js';
import { review } from './agents/review/index.js';
import { test } from './agents/test.js';
import { cicd } from './agents/cicd.js';
import { planner } from './agents/planner.js';
import { clarifier } from './agents/clarifier.js';
import { runSpec } from './workflows/spec.js';
import { startSpecSession } from './workflows/spec-session.js';
import { loadProjectConfig } from './lib/project-config.js';
import { getRun } from './store/runs.js';
import { listAgents } from './agents/index.js';
import { costGuard } from './lib/cost-guard.js';
import { getStats } from './store/runs.js';
import { getIssueTracker } from './integrations/issue-tracker/index.js';
import { processIssue } from './workflows/from-issue.js';
import { circuitBreaker } from './lib/circuit-breaker.js';
import { resolveProjectDir } from './lib/workspace.js';

function readInput(inputArg: string): string {
  if (existsSync(inputArg)) return readFileSync(inputArg, 'utf-8');
  return inputArg;
}

function printResult(result: { runId: string; output: string; tokensIn: number; tokensOut: number; durationMs: number }) {
  console.log(result.output);
  console.error(JSON.stringify({ runId: result.runId, tokensIn: result.tokensIn, tokensOut: result.tokensOut, durationMs: result.durationMs }));
}

const program = new Command();
program.name('auto-dev').description('Claude Code SDK 기반 개발 자동화 에이전트').version('0.1.0');

program.command('scaffold <input>')
  .description('코드 스캐폴딩 에이전트 실행')
  .action(async (input: string) => {
    const result = await scaffold(readInput(input), { triggerSource: 'cli' });
    printResult(result);
  });

program.command('review <input>')
  .description('코드 리뷰 에이전트 실행')
  .action(async (input: string) => {
    const result = await review(readInput(input), { triggerSource: 'cli' });
    printResult(result);
  });

program.command('test <input>')
  .description('테스트 에이전트 실행')
  .action(async (input: string) => {
    const result = await test(readInput(input), { triggerSource: 'cli' });
    printResult(result);
  });

program.command('cicd <input>')
  .description('CI/CD 에이전트 실행')
  .option('--cd', 'deployment/release artifacts도 생성')
  .action(async (input: string, options: { cd?: boolean }) => {
    const result = await cicd(readInput(input), { triggerSource: 'cli', deliveryIntent: options.cd ? 'cd' : 'ci' });
    printResult(result);
  });

program.command('planner <input>')
  .description('플래너 에이전트 실행')
  .action(async (input: string) => {
    const result = await planner(readInput(input), { triggerSource: 'cli' });
    printResult(result);
  });

program.command('clarifier <input>')
  .description('명세 정제 에이전트 실행')
  .action(async (input: string) => {
    const result = await clarifier(readInput(input), { triggerSource: 'cli' });
    printResult(result);
  });

program.command('spec <file>')
  .description('전체 스펙 워크플로우 실행')
  .option('--steps <steps>', '실행할 단계 (쉼표 구분)', '')
  .option('--iterations <n>', '피드백 재작업(planner/clarifier 라우팅) 허용 횟수', '4')
  .option('--project <project>', '프로젝트명 또는 경로')
  .option('--allow-test-regression', '의도된 테스트 수 감소를 허용하고 run/PR에 기록')
  .action(async (file: string, options: { steps: string; iterations: string; project?: string; allowTestRegression?: boolean }) => {
    const content = readFileSync(file, 'utf-8');
    const steps = options.steps ? new Set(options.steps.split(',').map(s => s.trim())) : undefined;
    const iterations = Number(options.iterations);
    const cwd = resolveProjectDir(options.project, content);
    const projectConfig = loadProjectConfig(cwd);
    if (projectConfig?.delivery?.mode === 'pull-request') {
      const session = startSpecSession(content, {
        project: options.project,
        cwd,
        steps,
        iterations,
        allowTestRegression: options.allowTestRegression,
        triggerSource: 'cli',
        triggerDetail: 'cli:spec',
      });
      await session.done;
      console.log(JSON.stringify(getRun(session.runId), null, 2));
      return;
    }
    const result = await runSpec(content, { steps, iterations, allowTestRegression: options.allowTestRegression, triggerSource: 'cli', cwd });
    console.log(JSON.stringify(result, null, 2));
  });

program.command('eval')
  .description('고정 fixture로 auto-dev spec workflow 평가')
  .option('--case <id>', '평가할 case ID (미지정 시 전체)')
  .option('--models <ids>', '비교할 모델 ID 목록 (쉼표 구분)')
  .action(async (options: { case?: string; models?: string }) => {
    try {
      const { formatEvalSummary, runEval } = await import('./workflows/eval.js');
      const result = await runEval({
        caseId: options.case,
        models: options.models?.split(',').map((model) => model.trim()).filter(Boolean),
      });
      console.log(formatEvalSummary(result.artifact, result.file));
      if (result.artifact.summary.failed > 0 || result.artifact.summary.skipped > 0) process.exitCode = 1;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program.command('issues')
  .description('이슈 트래커에서 열린 이슈 목록 조회')
  .action(async () => {
    const tracker = getIssueTracker();
    try {
      const issues = await tracker.fetchOpenIssues();
      if (issues.length === 0) {
        console.log('열린 이슈가 없거나 트래커가 연동되지 않았습니다.');
        return;
      }
      for (const i of issues) {
        console.log(`[${i.key}] ${i.title}  (${i.type}/${i.priority}/${i.status})  ${i.updatedAt}`);
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program.command('work <key>')
  .description('이슈를 SpecWorkflow로 자동 처리 (AUTO_DEV_ISSUE_TRACKER_URL 필요)')
  .action(async (key: string) => {
    try {
      const result = await processIssue(key);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program.command('status')
  .description('에이전트 현황 및 통계 조회')
  .action(() => {
    const guard = costGuard.stats();
    const circuit = circuitBreaker.stats();
    const stats = getStats();
    console.log(JSON.stringify({ agents: listAgents(), guard, circuit, stats }, null, 2));
  });

program.command('serve')
  .description('HTTP API 서버 시작')
  .action(async () => {
    const { startServer } = await import('./server/index.js');
    const { startBriefingSchedule } = await import('./schedule/briefing.js');
    startBriefingSchedule();
    await startServer();
  });

program.command('daemon')
  .description('스케줄러 + HTTP 서버 함께 시작')
  .action(async () => {
    const { startServer } = await import('./server/index.js');
    const { startBriefingSchedule } = await import('./schedule/briefing.js');
    startBriefingSchedule();
    await startServer();
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
