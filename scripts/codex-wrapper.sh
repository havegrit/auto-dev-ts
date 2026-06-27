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

exec codex "$@"
