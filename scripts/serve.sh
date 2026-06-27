#!/usr/bin/env bash
#
# auto-dev 서버를 비-root 유저로 실행한다.
#
# Claude Code SDK(query)는 permissionMode:'bypassPermissions'를 CLI 플래그
# --dangerously-skip-permissions 로 변환하는데, Claude Code는 root/sudo 실행 시
# 이 플래그를 보안상 거부한다("cannot be used with root/sudo privileges").
# 그 결과 root로 서버를 띄우면 모델 조회·완성·에이전트 실행이 전부 exit 1로 실패한다.
#
# 따라서 root로 실행되면 일반 유저로 권한을 낮춰 다시 실행한다.
# 실행 유저는 AUTO_DEV_RUN_AS_USER 로 변경 가능하다 (기본: shin).
#
set -euo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
PROJECT_ROOT="$(cd "$(dirname "$SCRIPT")/.." && pwd)"
cd "$PROJECT_ROOT"

RUN_AS="${AUTO_DEV_RUN_AS_USER:-shin}"

if [ "$(id -u)" -eq 0 ] && [ "$RUN_AS" != "root" ]; then
  home="$(getent passwd "$RUN_AS" | cut -d: -f6)"
  echo "auto-dev: root 감지 → '$RUN_AS' 유저로 권한 낮춰 실행합니다." >&2
  # `sudo env ...` 로 HOME/PATH를 명시 설정 (Claude 자격증명은 유저 HOME에 있다).
  exec sudo -u "$RUN_AS" env \
    HOME="$home" \
    PATH="/usr/local/bin:/usr/bin:/bin:${home}/.local/bin" \
    bash "$SCRIPT" "$@"
fi

exec ./node_modules/.bin/tsx src/cli.ts serve "$@"
