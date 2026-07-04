/**
 * OpenAI 호환 provider(NVIDIA NIM 등) 수동 스모크 테스트.
 *
 * 사용법:
 *   1) .env 에 아래 값 채우기
 *        AUTO_DEV_OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1
 *        AUTO_DEV_OPENAI_API_KEY=<네 NVIDIA 키>
 *        AUTO_DEV_OPENAI_MODELS=deepseek-ai/deepseek-v4-pro
 *   2) npx tsx scripts/smoke-openai.ts
 *
 * 모델을 인자로 덮어쓸 수도 있음:
 *   npx tsx scripts/smoke-openai.ts meta/llama-3.1-70b-instruct
 */
import '../src/env.js';
import { openaiCompleter } from '../src/llm/openai/completer.js';

async function main() {
  const model = process.argv[2] ?? (process.env.AUTO_DEV_OPENAI_MODELS ?? '').split(',')[0].trim();
  if (!process.env.AUTO_DEV_OPENAI_BASE_URL || !process.env.AUTO_DEV_OPENAI_API_KEY) {
    console.error('AUTO_DEV_OPENAI_BASE_URL / AUTO_DEV_OPENAI_API_KEY 를 .env 에 설정하세요.');
    process.exit(1);
  }
  if (!model) {
    console.error('모델을 지정하세요 (AUTO_DEV_OPENAI_MODELS 또는 인자).');
    process.exit(1);
  }

  console.log(`[smoke] model=${model} baseURL=${process.env.AUTO_DEV_OPENAI_BASE_URL}`);

  const text = await openaiCompleter.complete({
    system: 'You are a terse assistant.',
    message: 'Reply with exactly the word: pong',
    model,
  });
  console.log('[smoke] text →', JSON.stringify(text));

  const json = await openaiCompleter.complete({
    message: 'Return an object with a single key "ok" set to true.',
    json: true,
    model,
  });
  console.log('[smoke] json →', json);

  console.log('[smoke] OK');
}

main().catch(err => {
  console.error('[smoke] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
