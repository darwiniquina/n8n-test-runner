import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Execution, N8nClient } from './n8n-client.ts';
import { startServer } from './server.ts';

const TOKEN = 'test-token';

const SCENARIO = `name: Echo
workflow: Echo
steps:
  - name: Call
    trigger:
      webhook:
        path: echo
    expect:
      response:
        status: 200
`;

const execution: Execution = {
  id: '500',
  status: 'success',
  mode: 'webhook',
  startedAt: '2026-10-29T00:00:00.000Z',
  stoppedAt: '2026-10-29T00:00:01.000Z',
  data: {
    resultData: {
      runData: {
        Webhook: [{ data: { main: [[{ json: { ok: true } }]] } }],
      },
    },
  },
};

const notUsed = async (): Promise<never> => {
  throw new Error('Not expected in this test.');
};

const fakeClient: N8nClient = {
  isHealthy: async () => true,
  checkApiKey: async () => {},
  findWorkflowByName: notUsed,
  resolveWorkflow: async (name) => ({ id: 'wf-1', name, active: true }),
  createWorkflow: notUsed,
  activateWorkflow: notUsed,
  deleteWorkflow: notUsed,
  createCredential: notUsed,
  findCredentialsByName: notUsed,
  deleteCredential: notUsed,
  triggerWebhook: async () => ({ status: 200, body: { ok: true }, durationMs: 1 }),
  triggerHarness: notUsed,
  getExecution: notUsed,
  findExecution: async () => execution,
};

type Reply = { status: number; text: string; json: () => any };

let root: string;
let server: Awaited<ReturnType<typeof startServer>>;

// node:http instead of fetch, because fetch does not let us set Host.
function call(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);

  return new Promise((resolveCall, rejectCall) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: server.port,
        path,
        method: options.method ?? 'GET',
        headers: {
          host: `127.0.0.1:${server.port}`,
          'x-n8nt-token': TOKEN,
          'content-type': 'application/json',
          ...options.headers,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () =>
          resolveCall({ status: res.statusCode ?? 0, text, json: () => JSON.parse(text) }),
        );
      },
    );

    req.on('error', rejectCall);
    req.end(body);
  });
}

function parseEvents(text: string) {
  return text
    .trim()
    .split('\n\n')
    .map((block) => {
      const [eventLine, dataLine] = block.split('\n');
      return {
        event: eventLine.replace('event: ', ''),
        data: JSON.parse(dataLine.replace('data: ', '')),
      };
    });
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'n8nt-server-'));
  await mkdir(join(root, 'onboarding'));
  await writeFile(join(root, 'onboarding', 'echo.yaml'), SCENARIO);
  await writeFile(
    join(root, 'n8nt.config.yaml'),
    'environments:\n  local:\n    baseUrl: http://localhost:5678\n',
  );

  server = await startServer({
    root,
    port: 0,
    token: TOKEN,
    createClient: () => fakeClient,
  });
});

after(() => server.close());

describe('server security', () => {
  it('rejects requests for another Host (DNS rebinding)', async () => {
    const reply = await call('/api/tree', { headers: { host: 'evil.example:80' } });
    assert.equal(reply.status, 403);
  });

  it('rejects API calls without the right token', async () => {
    assert.equal((await call('/api/tree', { headers: { 'x-n8nt-token': '' } })).status, 401);
    assert.equal((await call('/api/tree', { headers: { 'x-n8nt-token': 'wrong' } })).status, 401);
  });

  it('serves the page without a token, since it holds no data', async () => {
    const reply = await call('/', { headers: { 'x-n8nt-token': '' } });
    assert.equal(reply.status, 200);
  });

  it('refuses files outside the workspace', async () => {
    const reply = await call('/api/files?path=..%2Foutside.yaml');
    assert.equal(reply.status, 403);
  });
});

describe('server files', () => {
  it('lists the tree and returns a file with its validation', async () => {
    const tree = (await call('/api/tree')).json();
    assert.equal(tree[0].path, 'onboarding');

    const file = (await call('/api/files?path=onboarding%2Fecho.yaml')).json();
    assert.equal(file.content, SCENARIO);
    assert.deepEqual(file.validation, { valid: true });
  });

  it('refuses to save an invalid scenario unless forced', async () => {
    const path = '/api/files?path=onboarding%2Fdraft.yaml';

    const refused = await call(path, { method: 'PUT', body: { content: 'name: Draft' } });
    assert.equal(refused.status, 422);
    assert.equal(refused.json().validation.valid, false);

    const forced = await call(path, {
      method: 'PUT',
      body: { content: 'name: Draft', force: true },
    });
    assert.equal(forced.status, 200);
    assert.equal(await readFile(join(root, 'onboarding', 'draft.yaml'), 'utf8'), 'name: Draft');
  });

  it('lists environments without keys or secrets', async () => {
    const reply = (await call('/api/environments')).json();

    assert.deepEqual(reply, {
      defaultEnvironment: 'local',
      environments: [
        {
          name: 'local',
          baseUrl: 'http://localhost:5678',
          webhookBaseUrl: 'http://localhost:5678',
        },
      ],
    });
  });
});

describe('server runs', () => {
  it('streams progress events and saves the run to history', async () => {
    const reply = await call('/api/runs', {
      method: 'POST',
      body: { paths: ['onboarding/echo.yaml'] },
    });
    const events = parseEvents(reply.text);

    assert.deepEqual(
      events.map((event) => event.event),
      ['run-start', 'scenario-start', 'step-start', 'step-end', 'scenario-end', 'run-end'],
    );

    const scenarioEnd = events[4].data.result;
    assert.equal(scenarioEnd.file, 'onboarding/echo.yaml');
    assert.equal(scenarioEnd.passed, true);
    // The UI always gets node output, even without execution checks.
    assert.deepEqual(scenarioEnd.steps[0].execution.nodes[0].items, [{ ok: true }]);

    const runId = events[0].data.id;
    const runs = (await call('/api/runs')).json();
    assert.equal(runs[0].id, runId);
    assert.equal((await call(`/api/runs/${runId}`)).json().results.length, 1);
  });

  it('rejects a run without paths or with paths outside the workspace', async () => {
    assert.equal((await call('/api/runs', { method: 'POST', body: {} })).status, 400);

    const outside = await call('/api/runs', { method: 'POST', body: { paths: ['..'] } });
    assert.equal(outside.status, 403);
  });

  it('reports an unknown environment as a bad request', async () => {
    const reply = await call('/api/runs', {
      method: 'POST',
      body: { paths: ['onboarding'], environment: 'nope' },
    });

    assert.equal(reply.status, 400);
    assert.match(reply.json().error, /Unknown environment/);
  });
});
