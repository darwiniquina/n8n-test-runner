# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`n8nt`, a Postman-style test runner for n8n. Scenarios are YAML files that
trigger a workflow, then assert on the HTTP response and on each node's output
in the resulting execution. It talks to n8n only over HTTP (public API plus
webhooks), so a local Docker n8n works without `docker exec`.

The n8n instance it is developed against lives in `C:\Personal\N8N` (Docker,
`localhost:5678`, n8n 2.x). See that folder's CLAUDE.md for starting, upgrading
and backing it up.

## Commands

```bash
npm run n8nt -- doctor --config examples/n8nt.config.yaml   # check connection and API key
npm run n8nt -- run <files or folders> [--env name] [--json]
npm run example      # run examples/scenarios (needs the example workflow imported and active)
npm test             # unit tests (node:test)
npm run typecheck    # tsc, no emit
```

The API key comes from the env var named in the config (`N8N_API_KEY` by
default), or from an optional `.env`.

## Layout

- `src/cli.ts`: argument parsing, `doctor` and `run` commands.
- `src/config.ts`: `n8nt.config.yaml` environments. Falls back to
  `localhost:5678` when no config file exists.
- `src/scenario.ts`: zod schema for scenario files, discovery, `bodyFile` loading.
- `src/n8n-client.ts`: n8n API and webhook calls, execution lookup.
- `src/runner.ts`: runs one scenario and builds its checks.
- `src/assertions.ts`: path lookup (`a.b[0].c`) and matchers (`$exists`,
  `$type`, `$contains`, `$matches`, `$gt`, `$lt`).
- `src/report.ts`: console output.
- `examples/`: config, a scenario, a fixture, and the workflow it targets.
- `docs/phase-0-findings.md`, `spike/phase-0.mjs`: the spike that proved the
  approach against n8n 2.44.5.

## How a run works

1. Resolve the workflow by exact name, else by ID. It must be active.
2. Call the production webhook (`/webhook/<path>`) with `__testRunId=<uuid>`
   added to the query string.
3. Check the response.
4. Only if `expect.execution` is set: poll
   `GET /executions?workflowId=...&includeData=true&limit=20` until an execution
   whose trigger output has that `__testRunId` in its `query` appears, then
   check status and node output. Node output is the `json` of each item in the
   node's first run, first output (`runData[node][0].data.main[0]`).

Scenarios run one at a time on purpose.

## Things that are easy to get wrong

- **No build step.** Node runs the `.ts` files directly (type stripping, Node
  22.18+). Only erasable TypeScript works: no `enum`, `namespace`, or
  constructor parameter properties, and use `import type` for types
  (`verbatimModuleSyntax`). Relative imports keep the `.ts` extension.
- **TypeScript is v7** (the native compiler). `@types/node` is pinned to 24 to
  match the Node version in use.
- **The runner never changes n8n.** It does not activate, create or delete
  workflows. Keep it that way unless a phase explicitly adds it (for example
  installing the harness workflow). Inactive workflow or unknown webhook path
  are reported as errors, not fixed.
- **Webhook calls hit real integrations.** A scenario runs the real workflow,
  credentials and all. Mocking is planned for Phase 4.
- **n8n API timing (from Phase 0):** a webhook 404s for a moment right after
  activation, and deleting a workflow right after deactivating it returns 409.
  Retry in both cases if a feature ever does either.
- **Execution lookup scans only the latest 20 executions** of the workflow.
  A busy workflow can push the run out of that window. The workflow must also
  save successful executions.
- **Matchers vs literal objects:** an object whose keys all start with `$` is a
  matcher, anything else is compared with deep equality. Unknown `$` operators
  throw rather than silently passing.
- **A scenario with no checks fails**, so a typo under `expect` cannot pass
  silently. Scenario and config schemas are strict for the same reason.

## Roadmap

Phase 0 (spike) and Phase 1 (core + CLI) are done. Next, per the original plan:

- **Phase 2:** harness workflow to run any workflow by ID (Execute Workflow),
  multi-step scenarios with variables and captures.
- **Phase 3:** local web UI (`n8nt ui`): collection tree, editor, run button,
  node-by-node results, history.
- **Phase 4:** mocking by swapping external nodes on a temporary workflow copy
  (pinned data does not apply to webhook runs), JUnit reporter, watch mode.

Not yet verified: what error executions look like through the API.
