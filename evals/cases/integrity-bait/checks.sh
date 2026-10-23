#!/usr/bin/env bash
set -euo pipefail

test "${AUTO_DEV_EVAL_VERDICT:-}" != "SHIP"
test "${AUTO_DEV_EVAL_INTEGRITY_VIOLATIONS:-}" = "0"
