// Calls to the `n8nt ui` server. Every /api call needs the per-launch token.

import type { listEnvironments } from '../../src/config.ts';
import type { RunRecord, RunSummary } from '../../src/history.ts';
import type { TreeNode, Validation, ValidationError } from '../../src/workspace.ts';
import type { RunEvent } from './run.ts';
import { createEventParser } from './sse.ts';

export type { RunSummary, TreeNode, Validation, ValidationError };
export type Environments = Awaited<ReturnType<typeof listEnvironments>>;
export type FileContent = { path: string; content: string; validation: Validation };

const TOKEN_KEY = 'n8nt-token';

// The server prints the token in the URL once. Keep it for reloads, and take
// it out of the address bar so it does not end up in history or screenshots.
function readToken() {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('token');

  if (fromUrl) {
    sessionStorage.setItem(TOKEN_KEY, fromUrl);
    url.searchParams.delete('token');
    history.replaceState(null, '', url);
  }

  return sessionStorage.getItem(TOKEN_KEY) ?? '';
}

const token = readToken();

export class ApiError extends Error {
  status: number;
  body: any;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function request(path: string, init: RequestInit = {}) {
  return fetch(path, {
    ...init,
    headers: { 'X-N8nt-Token': token, 'Content-Type': 'application/json' },
  });
}

function failure(response: Response, body: any) {
  const message =
    response.status === 401
      ? 'Missing or wrong token. Open the URL that `n8nt ui` printed.'
      : (body?.error ?? `Request failed (${response.status}).`);
  return new ApiError(message, response.status, body);
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await request(path, init);
  const body = await response.json().catch(() => undefined);

  if (!response.ok) {
    throw failure(response, body);
  }

  return body as T;
}

// Resolves when the server ends the stream, normally after run-end or run-error.
async function startRun(
  paths: string[],
  environment: string,
  onEvent: (event: RunEvent) => void,
) {
  const response = await request('/api/runs', {
    method: 'POST',
    body: JSON.stringify({ paths, environment }),
  });

  if (!response.ok) {
    throw failure(response, await response.json().catch(() => undefined));
  }

  const parse = createEventParser((event, data) => onEvent({ event, data } as RunEvent));
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return;
    }
    parse(value);
  }
}

const fileUrl = (path: string) => `/api/files?path=${encodeURIComponent(path)}`;

export const api = {
  tree: () => call<TreeNode[]>('/api/tree'),
  environments: () => call<Environments>('/api/environments'),
  readFile: (path: string) => call<FileContent>(fileUrl(path)),
  // Throws ApiError 422 with `body.validation` when the content is invalid.
  saveFile: (path: string, content: string, force = false) =>
    call<{ saved: true; validation: Validation }>(fileUrl(path), {
      method: 'PUT',
      body: JSON.stringify({ content, force }),
    }),
  validate: (path: string, content: string) =>
    call<Validation>('/api/validate', {
      method: 'POST',
      body: JSON.stringify({ path, content }),
    }),
  runs: () => call<RunSummary[]>('/api/runs'),
  run: (id: string) => call<RunRecord>(`/api/runs/${encodeURIComponent(id)}`),
  startRun,
};
