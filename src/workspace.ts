// File access for the UI server. Every path comes from the browser, so each one
// is checked to stay inside the scenario folder, after resolving symlinks.

import { lstat, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { isMap, isNode, isScalar, parseDocument, type Document } from 'yaml';
import { z } from 'zod';
import { configSchema } from './config.ts';
import { scenarioFileSchema } from './scenario.ts';

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

export type ValidationError = {
  message: string;
  // Offsets into the content, when the error points at a place in it.
  from?: number;
  to?: number;
};

export type Validation = { valid: true } | { valid: false; errors: ValidationError[] };

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
      return { valid: false, errors: [{ message: (error as Error).message }] };
    }
  }

  const document = parseDocument(content);
  if (document.errors.length > 0) {
    return {
      valid: false,
      errors: document.errors.map((error) => ({
        message: error.message,
        from: error.pos[0],
        to: error.pos[1],
      })),
    };
  }

  const schema = CONFIG_FILE_PATTERN.test(fileName) ? configSchema : scenarioFileSchema;
  const result = schema.safeParse(document.toJS());
  if (result.success) {
    return { valid: true };
  }

  return {
    valid: false,
    errors: result.error.issues.map((issue) => ({
      message: issue.path.length
        ? `${z.core.toDotPath(issue.path)}: ${issue.message}`
        : issue.message,
      ...issueRange(document, content, issue),
    })),
  };
}

// Points a schema issue at the YAML behind it: an unknown key itself, else the
// closest node on its path that exists (a missing key marks its parent).
// Issues about the whole file, like "steps or trigger", get no range.
function issueRange(document: Document, content: string, issue: z.core.$ZodIssue) {
  const path = issue.path.filter((key) => typeof key !== 'symbol');

  if (issue.code === 'unrecognized_keys') {
    const map = document.getIn(path, true);
    const pair = isMap(map)
      ? map.items.find((item) => isScalar(item.key) && item.key.value === issue.keys[0])
      : undefined;

    if (isNode(pair?.key) && pair.key.range) {
      return { from: pair.key.range[0], to: pair.key.range[1] };
    }
  }

  for (let length = path.length; length > 0; length--) {
    const node = document.getIn(path.slice(0, length), true);

    if (isNode(node) && node.range) {
      const from = node.range[0];
      // A whole map or list would underline many lines, so stop at its first.
      const lineEnd = content.indexOf('\n', from);
      const to = Math.min(node.range[1], lineEnd === -1 ? content.length : lineEnd);
      return { from, to };
    }
  }

  return {};
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

    // A symlink inside the folder could still point outside it, or at a file
    // like .env, so the real target is checked, not just the name.
    const realPath = await realTarget(fullPath, path, mustExist);

    if (!isInside(rootPath, realPath)) {
      throw new WorkspaceError('Path is outside the workspace.', 403);
    }

    if (!EDITABLE_EXTENSIONS.has(extname(realPath))) {
      throw new WorkspaceError('Only .yaml, .yml and .json files can be opened.', 400);
    }

    return fullPath;
  }

  async function realTarget(fullPath: string, path: string, mustExist: boolean) {
    try {
      return await realpath(fullPath);
    } catch (error) {
      if (mustExist || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new WorkspaceError(`Not found: ${path}`, 404);
      }
    }

    // A new file. A dangling symlink also lands here, and writing through it
    // would create its target wherever it points, so the name must be free.
    const isDangling = await lstat(fullPath).then(
      () => true,
      () => false,
    );
    if (isDangling) {
      throw new WorkspaceError('Path is outside the workspace.', 403);
    }

    try {
      return join(await realpath(dirname(fullPath)), basename(fullPath));
    } catch {
      throw new WorkspaceError(`Not found: ${path}`, 404);
    }
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
