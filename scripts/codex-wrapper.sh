#!/usr/bin/env bash
set -euo pipefail

home="${HOME:-}"
if [ -z "$home" ] || [[ "$home" == /root* ]]; then
  home="$(getent passwd "$(id -un)" | cut -d: -f6)"
fi

if [ -n "$home" ] && [ "$home" != "/root" ]; then
  export HOME="$home"
  export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
  export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
fi

if [ "${1:-}" = "exec" ]; then
  shift
  # auto-dev는 워크스페이스별로 Codex를 실행하므로 Git 신뢰 체크를 우회한다.
  # 사용자 ~/.codex 설정의 MCP/도구 구성을 끌어오지 않도록 무시한다.
  if [ "${AUTO_DEV_CODEX_BYPASS_SANDBOX:-}" = "1" ]; then
    exec codex exec --ignore-user-config --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "$@"
  fi
  exec codex exec --ignore-user-config --skip-git-repo-check "$@"
fi

exec codex "$@"
