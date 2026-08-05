#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
template="$project_root/deploy/systemd/auto-dev.service.in"
config_root="${XDG_CONFIG_HOME:-${HOME}/.config}"
unit_dir="$config_root/systemd/user"
unit_path="$unit_dir/auto-dev.service"
temp_unit="$(mktemp)"

cleanup() {
  rm -f "$temp_unit"
}
trap cleanup EXIT

mkdir -p "$unit_dir"
escaped_root="${project_root//&/\\&}"
sed "s|@PROJECT_ROOT@|$escaped_root|g" "$template" > "$temp_unit"
install -m 0644 "$temp_unit" "$unit_path"

systemctl --user daemon-reload
systemctl --user enable auto-dev.service

linger="$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)"
if [ "$linger" != "yes" ]; then
  echo "auto-dev: SSH 로그아웃 후에도 user service를 유지하려면 다음 명령이 필요합니다:" >&2
  echo "  sudo loginctl enable-linger $(id -un)" >&2
fi

echo "auto-dev: installed $unit_path"
echo "auto-dev: start with: systemctl --user start auto-dev.service"
echo "auto-dev: logs with: journalctl --user -u auto-dev.service -f"
