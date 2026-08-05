---
name: auto-dev-spec
description: Start, inspect, and cancel local auto-dev specification workflows. Use when a Telegram user asks OpenClaw to implement a spec, check an auto-dev run, or stop a run.
metadata: {"openclaw":{"requires":{"bins":["node"]}}}
---

# Auto Dev Spec

Use the deterministic bridge script. Never run the implementation yourself.

## Start

Extract:

- `project`: workspace project name, when supplied.
- `content`: the complete requested specification.
- `deliveryIntent`: `cd` only when deployment is explicit; otherwise `ci`.

Pass the specification over stdin so multiline text and shell characters are preserved:

```bash
node "{baseDir}/scripts/auto-dev.mjs" start --project "PROJECT" <<'AUTO_DEV_SPEC'
FULL SPECIFICATION
AUTO_DEV_SPEC
```

Omit `--project` when absent. Add `--cd` only for explicit deployment. Auto-clarification is enabled by default so Telegram requests do not stop for routine questions.

Return the accepted run ID. Say that completion/failure will arrive through Telegram. HTTP `202` means accepted, not completed.

## Status

```bash
node "{baseDir}/scripts/auto-dev.mjs" status RUN_ID
```

Summarize the stored status, result, and failure reason. Do not claim success while status is `RUNNING`.

## Cancel

```bash
node "{baseDir}/scripts/auto-dev.mjs" cancel RUN_ID
```

State whether cancellation was accepted.

## Input rules

- Require a meaningful specification before `start`.
- Never invent a project name or run ID.
- Keep API tokens and local paths out of Telegram replies.
- The bridge must remain on `127.0.0.1`; do not expose it publicly.
- For direct invocation, users can type `/auto_dev_spec ...` or `/skill auto-dev-spec ...`.
