import { existsSync } from 'fs';
import { userInfo } from 'os';

/**
 * .env 파일을 프로세스 환경변수로 로드한다 (Node 네이티브 loadEnvFile 사용).
 *
 * 주의: cost-guard/db/workspace/model-config 등은 import 시점에 환경변수를 읽으므로,
 * 이 모듈은 그 어떤 import보다 먼저 평가돼야 한다. cli.ts의 최상단에서 가장 먼저 import할 것.
 */
const envPath = process.env.AUTO_DEV_ENV_FILE ?? '.env';
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

function isRootPath(value: string | undefined): boolean {
  return Boolean(value && (value === '/root' || value.startsWith('/root/')));
}

function effectiveUserHome(): string | undefined {
  try {
    return userInfo().homedir || undefined;
  } catch {
    return undefined;
  }
}

const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
if (uid !== 0) {
  const home = effectiveUserHome();
  if (home && home !== '/root') {
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME && !isRootPath(process.env.XDG_CONFIG_HOME)
      ? process.env.XDG_CONFIG_HOME
      : `${home}/.config`;
    process.env.CODEX_HOME = `${home}/.codex`;
  }
  if (!process.env.AUTO_DEV_CODEX_COMMAND) {
    process.env.AUTO_DEV_CODEX_COMMAND = `${process.cwd()}/scripts/codex-wrapper.sh`;
  }
}
