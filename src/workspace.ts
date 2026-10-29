// File access for the UI server. Every path comes from the browser, so each one
// is checked to stay inside the scenario folder, after resolving symlinks.

import { readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import { parseConfig } from './config.ts';
import { parseScenario } from './scenario.ts';

const EDITABLE_EXTENSIONS = new Set(['.yaml', '.yml', '.json']);
const SKIPPED_FOLDERS = new Set(['node_modules', '.git', '.runs']);
const CONFIG_FILE_PATTERN = /^n8nt\.config\.ya?ml$/;

export class WorkspaceError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export type TreeNode = {
  name: string;
  // Relative to the workspace, always with "/" so the UI never sees "\".
  path: string;
  type: 'folder' | 'file';
  children?: TreeNode[];
};

export type Validation = { valid: true } | { valid: false; errors: string[] };

function isInside(parent: string, child: string) {
  const path = relative(parent, child);
  return path === '' || (path.split(sep)[0] !== '..' && !isAbsolute(path));
}

function toPosix(path: string) {
  return path.split(sep).join('/');
}

// Checks content the way the runner would read it: YAML syntax first, then the
// config or scenario schema. JSON fixtures only need to parse.
export function validateDocument(path: string, content: string): Validation {
  const fileName = path.split('/').pop() ?? path;

  if (extname(fileName) === '.json') {
    try {
      JSON.parse(content);
      return { valid: true };
    } catch (error) {
      return { valid: false, errors: [(error as Error).message] };
    }
  }

  const document = parseDocument(content);
  if (document.errors.length > 0) {
    return { valid: false, errors: document.errors.map((error) => error.message) };
  }

  try {
    if (CONFIG_FILE_PATTERN.test(fileName)) {
      parseConfig(document.toJS());
    } else {
      parseScenario(document.toJS(), path);
    }

    return { valid: true };
  } catch (error) {
    return { valid: false, errors: [(error as Error).message] };
  }
}

export async function createWorkspace(root: string) {
  const rootPath = await realpath(resolve(root));

  async function resolveEditable(path: string, mustExist: boolean) {
    if (!EDITABLE_EXTENSIONS.has(extname(path))) {
      throw new WorkspaceError('Only .yaml, .yml and .json files can be opened.', 400);
    }

    const fullPath = resolve(rootPath, path);
    if (!isInside(rootPath, fullPath)) {
      throw new WorkspaceError('Path is outside the workspace.', 403);
    }

    // A symlink inside the folder could still point outside it.
    const checkPath = mustExist ? fullPath : dirname(fullPath);
    let realPath: string;

    try {
      realPath = await realpath(checkPath);
    } catch {
      throw new WorkspaceError(`Not found: ${path}`, 404);
    }

    if (!isInside(rootPath, realPath)) {
      throw new WorkspaceError('Path is outside the workspace.', 403);
    }

    return fullPath;
  }

  async function readTree(folder: string): Promise<TreeNode[]> {
    const entries = await readdir(folder, { withFileTypes: true });
    const nodes: TreeNode[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIPPED_FOLDERS.has(entry.name)) {
        continue;
      }

      const fullPath = join(folder, entry.name);
      const path = toPosix(relative(rootPath, fullPath));

      if (entry.isDirectory()) {
        const children = await readTree(fullPath);
        // Folders without anything editable would only add noise.
        if (children.length > 0) {
          nodes.push({ name: entry.name, path, type: 'folder', children });
        }
      } else if (entry.isFile() && EDITABLE_EXTENSIONS.has(extname(entry.name))) {
        nodes.push({ name: entry.name, path, type: 'file' });
      }
    }

    // Folders first, then files, each alphabetical.
    return nodes.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1,
    );
  }

  async function read(path: string) {
    return readFile(await resolveEditable(path, true), 'utf8');
  }

  async function write(path: string, content: string) {
    await writeFile(await resolveEditable(path, false), content);
  }

  // Turns a workspace-relative path into an absolute one for the runner.
  async function resolvePath(path: string) {
    const fullPath = resolve(rootPath, path);
    let realPath: string;

    try {
      realPath = await realpath(fullPath);
    } catch {
      throw new WorkspaceError(`Not found: ${path}`, 404);
    }

    if (!isInside(rootPath, realPath)) {
      throw new WorkspaceError('Path is outside the workspace.', 403);
    }

    return fullPath;
  }

  function relativePath(fullPath: string) {
    return toPosix(relative(rootPath, fullPath));
  }

  return {
    root: rootPath,
    tree: () => readTree(rootPath),
    read,
    write,
    resolvePath,
    relativePath,
  };
}

export type Workspace = Awaited<ReturnType<typeof createWorkspace>>;
