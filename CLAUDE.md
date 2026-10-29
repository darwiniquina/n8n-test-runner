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
- `src/scenario.ts`: zod schema for scenario files, discovery, `bodyFile`
  loading. Both forms (top-level `trigger` or `steps`) become a list of steps.
- `src/variables.ts`: `{{ name }}` interpolation, built-ins (`$uuid`, `$now`).
- `src/n8n-client.ts`: n8n API and webhook calls, execution lookup.
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

Done: Phase 0 (spike), Phase 1 (core + CLI), Phase 2 part 1 (multi-step
scenarios, variables, captures). Next:

- **Phase 2 part 2:** harness workflow to run any workflow by ID (branch
  `feat/harness`). Read `docs/phase-2-harness-findings.md` first: targets must
  be published, the target's execution ID is in the harness run on success and
  failure, and the harness secret appears in its execution data.
- **Phase 3:** local web UI (`n8nt ui`): collection tree, editor, run button,
  node-by-node results, history.
- **Phase 4:** mocking by swapping external nodes on a temporary workflow copy
  (pinned data does not apply to webhook runs), JUnit reporter, watch mode.
