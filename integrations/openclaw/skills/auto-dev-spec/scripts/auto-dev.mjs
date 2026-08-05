#!/usr/bin/env node

const baseUrl = (process.env.AUTO_DEV_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const token = process.env.AUTO_DEV_OPENCLAW_API_TOKEN?.trim();

function usage(message) {
  if (message) console.error(message);
  console.error('Usage: auto-dev.mjs start [--project NAME] [--iterations N] [--cd] [--no-auto-clarify] | status RUN_ID | cancel RUN_ID | health');
  process.exitCode = 2;
}

function headers(json = false) {
  return {
    ...(json ? { 'content-type': 'application/json' } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { ...headers(Boolean(options.body)), ...options.headers },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: text || `HTTP ${response.status}` };
  }
  if (!response.ok) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return body;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function startOptions(args) {
  const options = {
    autoClarify: true,
    maxClarifyRounds: 0,
    deliveryIntent: 'ci',
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--project') {
      const project = args[++index]?.trim();
      if (!project) throw new Error('--project requires a value');
      options.project = project;
    } else if (arg === '--iterations') {
      const iterations = Number(args[++index]);
      if (!Number.isInteger(iterations) || iterations < 0) throw new Error('--iterations requires a non-negative integer');
      options.iterations = iterations;
    } else if (arg === '--cd') {
      options.deliveryIntent = 'cd';
    } else if (arg === '--no-auto-clarify') {
      options.autoClarify = false;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function printRun(run) {
  const output = String(run.output || '').trim();
  console.log(JSON.stringify({
    runId: run.id,
    status: run.status,
    startedAt: run.started_at,
    durationMs: run.duration_ms,
    result: output.slice(0, 1800) || undefined,
    errorType: run.error_type || undefined,
    stopReason: run.stop_reason || undefined,
  }, null, 2));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) return usage();

  if (command === 'health') {
    console.log(JSON.stringify(await request('/api/integrations/openclaw/health'), null, 2));
    return;
  }

  if (command === 'start') {
    const content = await readStdin();
    if (!content) return usage('Specification content is required on stdin.');
    const result = await request('/api/integrations/openclaw/specs', {
      method: 'POST',
      body: JSON.stringify({ ...startOptions(args), content }),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const runId = args[0]?.trim();
  if (!runId || args.length !== 1) return usage(`${command} requires exactly one run ID.`);

  if (command === 'status') {
    printRun(await request(`/api/runs/${encodeURIComponent(runId)}`));
    return;
  }
  if (command === 'cancel') {
    console.log(JSON.stringify(await request(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }), null, 2));
    return;
  }
  return usage(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`auto-dev bridge failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
