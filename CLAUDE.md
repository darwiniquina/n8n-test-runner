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
npm run n8nt -- harness install|uninstall --config examples/n8nt.config.yaml
npm run n8nt -- ui examples --no-open      # local UI server for a scenario folder
npm run example          # examples/scenarios (needs examples/workflows/echo.json imported and active)
npm run example:harness  # examples/harness-scenarios (needs the harness and double.json)
npm test             # unit tests (node:test)
npm run typecheck    # tsc, no emit
```

CI (`.github/workflows/ci.yml`) runs `typecheck` and `test` on Node 22 and 24
for every PR and push to `main`. It has no n8n instance, so anything that needs
one must stay out of `npm test`.

The API key comes from the env var named in the config (`N8N_API_KEY` by
default), or from an optional `.env`.

## Layout

- `src/cli.ts`: argument parsing, `doctor` and `run` commands.
- `src/config.ts`: `n8nt.config.yaml` environments. Falls back to
  `localhost:5678` when no config file exists.
- `src/scenario.ts`: zod schema for scenario files, discovery, `bodyFile`
  loading. Both forms (top-level `trigger` or `steps`) become a list of steps.
- `src/variables.ts`: `{{ name }}` interpolation, built-ins (`$uuid`, `$now`).
- `src/n8n-client.ts`: n8n API and webhook calls, execution lookup.
- `src/harness.ts`: the harness workflow definition, install/uninstall, and
  finding the target's execution from a harness run.
- `src/server.ts`: `n8nt ui` HTTP server (node:http, no framework) and its
  `/api/*` routes.
- `src/workspace.ts`: safe file access inside the scenario folder, the file
  tree, and `validateDocument` (scenario or config schema).
- `src/history.ts`: run history as JSON files in `<scenario folder>/.runs/`.
- `src/runner.ts`: runs a scenario step by step, builds checks, captures values.
- `src/assertions.ts`: path lookup (`a.b[0].c`) and matchers (`$exists`,
  `$type`, `$contains`, `$matches`, `$gt`, `$lt`).
- `src/report.ts`: console output.
- `examples/`: config, a scenario, a fixture, and the workflow it targets.
- `docs/phase-0-findings.md`, `spike/phase-0.mjs`: the spike that proved the
  approach against n8n 2.44.5.

## How a run works

Variables resolve first: environment `variables` from the config, then the
scenario's `variables` (in order, each can use the ones before). Then, for each
step:

1. Interpolate `{{ name }}` in the trigger (path, query, headers, body) and in
   expected values.
2. Resolve the workflow by exact name, else by ID. It must be active.
3. Call the production webhook (`/webhook/<path>`) with `__testRunId=<uuid>`
   added to the query string.
4. Check the response.
5. Only if `expect.execution` is set or a capture reads a node: poll
   `GET /executions?workflowId=...&includeData=true&limit=20` until an execution
   whose trigger output has that `__testRunId` in its `query` appears, then
   check status and node output. Node output is the `json` of each item in the
   node's first run, first output (`runData[node][0].data.main[0]`).
6. Capture values into variables for later steps.

After a failed step, the remaining steps are skipped. Scenarios and steps run
one at a time on purpose.

### Harness triggers

`trigger: { harness: { input } }` posts `{ workflowId, input }` to the harness
webhook (`/webhook/n8nt-harness`, Header Auth `X-N8nt-Harness-Secret`). The
harness runs `Webhook → Prepare Input → Run Target (Execute Workflow)` and
responds with all of the target's output items. To check the execution, the
runner finds the harness run by `__testRunId`, reads the target's execution ID
from the "Run Target" run (`metadata.subExecution.executionId` on success,
`error.executionId` on failure), and fetches that execution. Checks and node
captures apply to the target's execution, never the harness's.

### UI server API

`n8nt ui [folder]` serves on `127.0.0.1` (default port 4567). Every `/api/*`
call needs the `X-N8nt-Token` header (random per launch, printed in the URL as
`?token=`).

| Route | Purpose |
|---|---|
| `GET /api/tree` | editable files (`.yaml`, `.yml`, `.json`), folders first |
| `GET /api/files?path=` | content plus `validation` |
| `PUT /api/files?path=` | `{ content, force? }`; 422 with `validation` when invalid and not forced |
| `POST /api/validate` | `{ path, content }` → validation, for live editor checks |
| `GET /api/environments` | names and URLs only, never keys |
| `POST /api/runs` | `{ paths, environment? }` → server-sent events: `run-start`, `scenario-start`, `step-start`, `step-end`, `scenario-end`, `run-end` (or `run-error`) |
| `GET /api/runs`, `GET /api/runs/:id` | history summaries, one full run |

UI runs pass `includeExecution`, so every step carries `execution.nodes`
(first run, first output, at most 20 items per node). The CLI does not, which
keeps `n8nt run` from polling for executions it does not check.

## Things that are easy to get wrong

- **No build step.** Node runs the `.ts` files directly (type stripping, Node
  22.18+). Only erasable TypeScript works: no `enum`, `namespace`, or
  constructor parameter properties, and use `import type` for types
  (`verbatimModuleSyntax`). Relative imports keep the `.ts` extension.
- **TypeScript is v7** (the native compiler). `@types/node` is pinned to 24 to
  match the Node version in use.
- **The UI server writes files and triggers n8n**, so keep its guards: bind
  to `127.0.0.1`, check `Host` against `127.0.0.1:<port>` and
  `localhost:<port>` (DNS rebinding), require the token on `/api/*`, and route
  every path through `workspace.ts`, which checks it after resolving symlinks.
  Only `.yaml`, `.yml` and `.json` can be read or written, so `.env` never is.
- **One UI run at a time** (409 otherwise). A run keeps going and is saved to
  history even if the browser closes the stream.
- **Only `n8nt harness install/uninstall` changes n8n.** `run` and `doctor`
  never create, activate or delete anything. An inactive workflow or an unknown
  webhook path is reported as an error, not fixed.
- **n8n 2.x only runs published workflows**, from webhooks and from other
  workflows alike. Harness targets must be active too.
- **The harness secret is in n8n's execution data** (the Webhook node's
  request headers). Never print raw output from the harness run.
- **Real environment variables win over `.env`** (`process.loadEnvFile` does not
  override). The CLI snapshots the environment before loading `.env` so
  `harness install` can warn when a real `N8N_HARNESS_SECRET` would shadow the
  new one.
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
- **A step with no checks and no captures fails**, so a typo under `expect`
  cannot pass silently. Scenario and config schemas are strict for the same
  reason. A capture that finds nothing also fails its step.
- **Unknown variables throw.** They never become an empty string, which would
  send wrong data to n8n.
- **A string that is exactly one placeholder keeps the variable's type**
  (`"{{ count }}"` can be a number). Mixed text always becomes a string. Paths,
  query values and headers always use the text form.
- **`$uuid` and `$now` give a new value on every reference.** Assign one to a
  scenario variable to reuse it.
- **zod 4 defaults:** `.default()` still fills in a value under `.optional()`.
  Scenario-level `expect`/`capture` must stay without defaults, or every
  multi-step file fails the "steps or trigger" check.

## Roadmap

Done: Phase 0 (spike), Phase 1 (core + CLI), Phase 2 (multi-step scenarios,
variables, captures, harness). Background for the harness is in
`docs/phase-2-harness-findings.md`. Next:

- **Phase 3:** local web UI. 3A (server and API) is done. 3B: React + Vite +
  CodeMirror frontend served by the same server, replacing `PLACEHOLDER_PAGE`
  in `server.ts`: file tree, YAML editor with inline validation, run button,
  live step results with expandable node output, history.
- **Phase 4:** mocking by swapping external nodes on a temporary workflow copy
  (pinned data does not apply to webhook runs), JUnit reporter, watch mode.
