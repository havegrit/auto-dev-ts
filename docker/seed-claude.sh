#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
credentials="${HOME:-}/.claude/.credentials.json"
settings="${HOME:-}/.claude/settings.json"

if [[ -z "$credentials" || ! -f "$credentials" ]]; then
  echo "Claude credentials not found: $credentials" >&2
  exit 1
fi

compose=(docker compose --project-directory "$project_root")
seed_mounts=("$credentials:/seed/.credentials.json:ro")
if [[ -f "$settings" ]]; then
  seed_mounts+=("$settings:/seed/settings.json:ro")
fi
seed_args=()
for mount in "${seed_mounts[@]}"; do
  seed_args+=( -v "$mount" )
done

echo "Seeding container-only Claude credentials volume..."
"${compose[@]}" run --rm --no-deps --user root \
  "${seed_args[@]}" \
  auto-dev sh -c '
    set -eu
    install -d -o app -g app /home/app/.claude
    install -o app -g app -m 0600 /seed/.credentials.json /home/app/.claude/.credentials.json
    if [ -f /seed/settings.json ]; then
      install -o app -g app -m 0600 /seed/settings.json /home/app/.claude/settings.json
    fi
  '

echo "Claude credentials seeded into the named volume."
