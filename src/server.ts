// Local HTTP server behind `n8nt ui`. It can write scenario files and trigger
// n8n, so it only listens on 127.0.0.1, checks the Host header (blocks DNS
// rebinding), and requires a random per-launch token on every API call.

import { timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  listEnvironments,
  loadEnvironment,
  type ConfigLocation,
  type Environment,
} from './config.ts';
import { createHistory, createRunId, type RunRecord } from './history.ts';
import { createN8nClient, type N8nClient } from './n8n-client.ts';
import { runScenarioFile } from './runner.ts';
import { findScenarioFiles } from './scenario.ts';
import { createWorkspace, validateDocument, WorkspaceError } from './workspace.ts';

const MAX_BODY_BYTES = 1024 * 1024;
const TOKEN_HEADER = 'x-n8nt-token';
const RUN_PATH = /^\/api\/runs\/([^/]+)$/;

// Replaced by the real UI in Phase 3B.
const PLACEHOLDER_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>n8nt</title></head>
<body style="font-family: system-ui, sans-serif; margin: 2rem;">
  <h1>n8nt UI server is running</h1>
  <p>The browser UI is not built yet. The API is available under <code>/api/</code>.</p>
</body>
</html>`;

export type ServerOptions = {
  root: string;
  configPath?: string;
  // 0 picks a free port (used by tests).
  port: number;
  token: string;
  createClient?: (environment: Environment) => N8nClient;
};

class HttpError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError('Request body is too large.', 413);
    }

    chunks.push(chunk as Buffer);
  }

  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError('Request body must be JSON.', 400);
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError('Request body must be a JSON object.', 400);
  }

  return body as Record<string, unknown>;
}

function tokensMatch(expected: string, received: string | string[] | undefined) {
  if (typeof received !== 'string') {
    return false;
  }

  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);

  return (
    expectedBytes.length === receivedBytes.length &&
    timingSafeEqual(expectedBytes, receivedBytes)
  );
}

function requiredParam(url: URL, name: string) {
  const value = url.searchParams.get(name);
  if (!value) {
    throw new HttpError(`Missing "${name}" query parameter.`, 400);
  }

  return value;
}

export async function startServer(options: ServerOptions) {
  const workspace = await createWorkspace(options.root);
  const history = createHistory(join(workspace.root, '.runs'));
  const configLocation: ConfigLocation = options.configPath
    ? { configPath: options.configPath }
    : { configDir: workspace.root };
  const createClient = options.createClient ?? createN8nClient;

  let port = options.port;
  let runInProgress = false;

  async function runFiles(request: IncomingMessage, response: ServerResponse) {
    const body = await readJson(request);
    const { paths } = body;

    if (
      !Array.isArray(paths) ||
      paths.length === 0 ||
      !paths.every((path) => typeof path === 'string')
    ) {
      throw new HttpError('Give "paths": a list of scenario files or folders.', 400);
    }

    const envName = typeof body.environment === 'string' ? body.environment : undefined;
    const environment = await loadEnvironment({ ...configLocation, envName }).catch(
      (error: Error) => {
        throw new HttpError(error.message, 400);
      },
    );

    const fullPaths = await Promise.all(paths.map((path) => workspace.resolvePath(path)));
    const files = await findScenarioFiles(fullPaths);
    if (files.length === 0) {
      throw new HttpError('No scenario files found in those paths.', 400);
    }

    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });

    // The browser may close the stream mid-run. The run still finishes and is
    // saved to history.
    const send = (event: string, data: unknown) => {
      if (!response.destroyed) {
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };

    const client = createClient(environment);
    const record: RunRecord = {
      id: createRunId(),
      startedAt: new Date().toISOString(),
      finishedAt: '',
      environment: environment.name,
      paths,
      results: [],
    };

    try {
      send('run-start', {
        id: record.id,
        environment: environment.name,
        files: files.map((file) => workspace.relativePath(file)),
      });

      for (const file of files) {
        const relativeFile = workspace.relativePath(file);
        send('scenario-start', { file: relativeFile });

        const result = await runScenarioFile(file, client, environment.variables, {
          includeExecution: true,
          onStepStart: (event) => send('step-start', { file: relativeFile, ...event }),
          onStepEnd: (event) => send('step-end', { file: relativeFile, ...event }),
        });

        result.file = relativeFile;
        record.results.push(result);
        send('scenario-end', { result });
      }

      record.finishedAt = new Date().toISOString();
      await history.save(record);

      const passed = record.results.filter((result) => result.passed).length;
      send('run-end', {
        id: record.id,
        passed,
        failed: record.results.length - passed,
      });
    } catch (error) {
      send('run-error', { message: (error as Error).message });
    } finally {
      response.end();
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    // Another site's hostname resolving to 127.0.0.1 would send its own Host.
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(request.headers.host ?? '')) {
      throw new HttpError('Host not allowed.', 403);
    }

    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);

    if (!url.pathname.startsWith('/api/')) {
      if (request.method !== 'GET') {
        throw new HttpError('Method not allowed.', 405);
      }

      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(PLACEHOLDER_PAGE);
      return;
    }

    // A custom header also means browsers will not send it cross-origin
    // without a CORS preflight, which this server never approves.
    if (!tokensMatch(options.token, request.headers[TOKEN_HEADER])) {
      throw new HttpError('Missing or wrong token.', 401);
    }

    const route = `${request.method} ${url.pathname}`;

    if (route === 'GET /api/tree') {
      sendJson(response, 200, await workspace.tree());
      return;
    }

    if (route === 'GET /api/files') {
      const path = requiredParam(url, 'path');
      const content = await workspace.read(path);
      sendJson(response, 200, { path, content, validation: validateDocument(path, content) });
      return;
    }

    if (route === 'PUT /api/files') {
      const path = requiredParam(url, 'path');
      const body = await readJson(request);
      if (typeof body.content !== 'string') {
        throw new HttpError('Give "content" as a string.', 400);
      }

      // Invalid files are refused unless the editor explicitly forces a save,
      // so a typo cannot quietly break a scenario.
      const validation = validateDocument(path, body.content);
      if (!validation.valid && body.force !== true) {
        sendJson(response, 422, { error: 'The file is not valid.', validation });
        return;
      }

      await workspace.write(path, body.content);
      sendJson(response, 200, { saved: true, validation });
      return;
    }

    if (route === 'POST /api/validate') {
      const body = await readJson(request);
      if (typeof body.path !== 'string' || typeof body.content !== 'string') {
        throw new HttpError('Give "path" and "content" as strings.', 400);
      }

      sendJson(response, 200, validateDocument(body.path, body.content));
      return;
    }

    if (route === 'GET /api/environments') {
      sendJson(response, 200, await listEnvironments(configLocation));
      return;
    }

    if (route === 'GET /api/runs') {
      sendJson(response, 200, await history.list());
      return;
    }

    const runMatch = url.pathname.match(RUN_PATH);
    if (request.method === 'GET' && runMatch) {
      const record = await history.get(runMatch[1]);
      if (!record) {
        throw new HttpError('Run not found.', 404);
      }

      sendJson(response, 200, record);
      return;
    }

    if (route === 'POST /api/runs') {
      // One run at a time keeps execution lookups simple and n8n unflooded.
      if (runInProgress) {
        throw new HttpError('A run is already in progress.', 409);
      }

      runInProgress = true;
      try {
        await runFiles(request, response);
      } finally {
        runInProgress = false;
      }
      return;
    }

    throw new HttpError('Not found.', 404);
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: Error) => {
      if (response.headersSent) {
        response.end();
        return;
      }

      const isKnown = error instanceof HttpError || error instanceof WorkspaceError;
      sendJson(response, isKnown ? error.status : 500, { error: error.message });
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      rejectListen(
        error.code === 'EADDRINUSE'
          ? new Error(`Port ${options.port} is in use. Pick another with --port.`)
          : error,
      );
    });
    server.listen(options.port, '127.0.0.1', resolveListen);
  });

  port = (server.address() as AddressInfo).port;

  return {
    port,
    url: `http://127.0.0.1:${port}/?token=${options.token}`,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections();
        server.close(() => resolveClose());
      }),
  };
}
