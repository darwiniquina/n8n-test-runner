// Calls to the `n8nt ui` server. Every /api call needs the per-launch token.

import type { listEnvironments } from '../../src/config.ts';
import type { TreeNode, Validation, ValidationError } from '../../src/workspace.ts';

export type { TreeNode, Validation, ValidationError };
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

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'X-N8nt-Token': token, 'Content-Type': 'application/json' },
  });
  const body = await response.json().catch(() => undefined);

  if (!response.ok) {
    const message =
      response.status === 401
        ? 'Missing or wrong token. Open the URL that `n8nt ui` printed.'
        : (body?.error ?? `Request failed (${response.status}).`);
    throw new ApiError(message, response.status, body);
  }

  return body as T;
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
};
