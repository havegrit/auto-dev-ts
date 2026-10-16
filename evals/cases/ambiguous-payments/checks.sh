#!/usr/bin/env bash
set -euo pipefail
test "$AUTO_DEV_EVAL_VERDICT" = "NEEDS-CLARIFICATION"
test "$AUTO_DEV_EVAL_ROUTE_COUNT" = "0"
