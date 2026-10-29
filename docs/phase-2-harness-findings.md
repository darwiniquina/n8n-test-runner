# Phase 2 harness findings

Spike: `spike/phase-2-harness.mjs`, run on 2026-10-29 against n8n 2.44.5
(Docker, `localhost:5678`). All spike workflows and the credential were
deleted afterwards (`--cleanup`).

Harness tested: Webhook (Header Auth, respond with all entries from the last
node) → Set "Prepare Input" (raw JSON from `body.input`) → Execute Workflow
"Run Target" (source database, workflow ID from `body.workflowId`, wait for
completion).

## Confirmed

- **Header Auth works.** Without the header or with a wrong secret, the
  webhook answers 403 and nothing runs. The credential can be created and
  deleted through the public API (`POST/DELETE /credentials`, type
  `httpHeaderAuth`).
- **The harness records the target's execution ID** in both outcomes:
  - success: `runData['Run Target'][0].metadata.subExecution.executionId`
    (plus `workflowId`)
  - failure: `runData['Run Target'][0].error.executionId` (plus `workflowId`),
    with no `metadata` on that run
- **The target's execution links back to the harness.** Its trigger run has
  `metadata.parentExecution.executionId`. That is a fallback way to find it.
  Target executions have `mode: "integrated"`.
- **Response:** on success, the harness responds 200 with an array of the
  target's output items (`allEntries`). On failure it responds 500 with
  `{"message":"Error in workflow"}`. The real error message is in the harness
  execution (`resultData.error.message`) and in the target execution.
- **Failed executions through the API:** `status: "error"`,
  `resultData.error.message`, `resultData.lastNodeExecuted`, and the failing
  node's run has `error` instead of `data`.

## Changes to the Phase 2 plan

- **Targets must be published (active).** n8n 2.x refuses to run an inactive
  sub-workflow from a production execution ("Workflow is not active and cannot
  be executed."). A workflow with only a "When Executed by Another Workflow"
  trigger can be activated. The runner should check this up front, as it
  already does for webhook workflows.
- **"Accept all data" is not required.** With defined input fields and a
  dynamic workflow ID, the target receives the input fields whose names match
  and silently drops the rest (`{ value, extra }` arrived as `{ value }`).
  Types still get converted (`value` stayed a number). Document that unknown
  input fields are dropped.

## Gotchas

- **The harness secret is stored in execution data.** The Webhook node's output
  includes all request headers, so anyone who can open the harness executions
  in n8n can read the secret. They already have full n8n access, so this is
  acceptable, but the runner must never print raw trigger output from the
  harness. Rotating is cheap: uninstall and install again.
- **Activation lag applies to the harness too** (Phase 0): the first call right
  after install can 404 for a moment.
- **Your n8n's `WEBHOOK_URL` currently points at an old trycloudflare address**
  (seen in the Webhook node's `webhookUrl`). It does not affect the runner,
  which calls `localhost`, but external services would be using a dead URL.
