# n8n test runner (`n8nt`)

Postman-style tests for n8n workflows, run locally. Each scenario is a YAML file
that triggers a workflow and checks the response and each node's output.

## Setup

Requires Node 22.18+ and an n8n API key (n8n: Settings, n8n API).

```bash
npm install
```

Set `N8N_API_KEY` in your environment, or copy `.env.example` to `.env`.

## Try the example

1. In n8n, import `examples/workflows/echo.json` and activate it.
2. Run:

```bash
npm run n8nt -- doctor --config examples/n8nt.config.yaml
npm run example
```

## Writing a scenario

```yaml
name: Echo returns the message it received
workflow: "n8nt example: echo"     # workflow name or ID, must be active

trigger:
  webhook:
    method: POST                   # default POST
    path: n8nt-echo
    bodyFile: ../fixtures/hello.json   # or inline: body: { message: hi }

expect:
  response:
    status: 200
    maxDurationMs: 5000
    body:
      echo: hello from n8nt

  execution:
    status: success
    nodes:
      Build Reply:
        output:
          "[0].echo": { $contains: n8nt }
      Send Alert:
        ran: false
```

Paths use `a.b[0].c`. Plain values are compared exactly. Matchers:
`$exists`, `$type`, `$contains`, `$matches`, `$gt`, `$lt`.

## Multi-step scenarios and variables

Use `steps` to chain calls. `capture` saves a value for later steps, and
`{{ name }}` uses it. After a failed step, the rest are skipped.

```yaml
name: Create then fetch employee
workflow: Employee API            # default for every step
variables:
  email: "test+{{ $uuid }}@example.com"

steps:
  - name: Create
    trigger:
      webhook:
        path: employees
        body: { email: "{{ email }}" }
    expect:
      response: { status: 201 }
    capture:
      employeeId: response.body.id                          # from the response
      rowNumber: { node: Append Row, path: "[0].row_number" }  # from a node's output

  - name: Fetch
    trigger:
      webhook:
        method: GET
        path: "employees/{{ employeeId }}"
    expect:
      response:
        body: { email: "{{ email }}" }
```

- Variables come from the environment's `variables` in `n8nt.config.yaml`, the
  scenario's `variables`, and captures. Built-ins: `{{ $uuid }}` and
  `{{ $now }}`, which give a new value on each use.
- A value that is exactly `"{{ name }}"` keeps its type (number, object).
- Unknown variables are an error, never an empty string.

Run a file or a whole folder:

```bash
npm run n8nt -- run path/to/scenarios --env local
```

Scenarios call the real workflow, so anything it writes or sends really happens.
