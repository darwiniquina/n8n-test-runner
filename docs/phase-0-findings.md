# Phase 0 findings

Spike: `spike/phase-0.mjs`, run on 2026-10-29 against n8n 2.44.5 (Docker, `localhost:5678`).
Result: all four checks pass, both on a fresh workflow and on an already active one.

## Confirmed

- **Connection:** `GET /healthz` plus `GET /api/v1/workflows?limit=1` with
  `X-N8N-API-KEY` is a good `doctor` check. No Docker access needed.
- **Trigger:** production webhooks (`/webhook/<path>`) work for workflows created
  and activated through the API. A response took about 90 to 120 ms.
- **Correlation:** the webhook response carries no execution ID. Tagging the
  payload with `__testRunId` and matching it against the Webhook node's output in
  `GET /executions?workflowId=...&includeData=true` found the run on the first
  poll every time.
- **Node output:** `GET /executions/{id}?includeData=true` returns parsed run data.
  Node output lives at `data.resultData.runData[node][0].data.main[0][i].json`.
  `status` (`success`) and `mode` (`webhook`) are top-level fields.
- **Workflow lifecycle:** `POST /workflows`, `/activate`, `/deactivate` and
  `DELETE` all work with the API key.

## Gotchas for Phase 1

- **Webhook registration lags activation.** The first call right after
  `/activate` returned 404 ("webhook is not registered"). It worked on the
  second try, 500 ms later. Retrying on 404 is safe because nothing ran.
- **Unpublishing is also asynchronous.** n8n 2.x refuses to delete an active
  ("published") workflow, and right after `/deactivate` the delete returns 409
  ("still being unpublished") for a moment. Retry on 409.
- **Correlation relies on the trigger node's output containing the payload.**
  That holds for webhooks. Other trigger types (harness, schedule) need their
  own way to find the run.
- **Matching scans recent executions** (limit 10). If a busy workflow gets many
  runs at once, the matching run can drop off that list. Phase 1 should page
  through results or filter by start time.

## Not covered yet

- Harness workflow (running any workflow by ID through Execute Workflow), and
  whether the caller can get the sub-execution ID.
- Error executions: what failed runs and error output look like in the API.
