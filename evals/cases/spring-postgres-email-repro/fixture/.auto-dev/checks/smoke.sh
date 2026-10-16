#!/usr/bin/env bash
set -euo pipefail
response="$(curl --fail --silent --show-error 'http://127.0.0.1:18080/api/users/lookup?email=%20Lee%40Example.com%20')"
test "$response" = 'lee@example.com'
