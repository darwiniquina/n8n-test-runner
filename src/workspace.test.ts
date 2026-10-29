import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createWorkspace, validateDocument } from './workspace.ts';

const SCENARIO = `name: Echo
workflow: Echo
trigger:
  webhook:
    path: echo
expect:
  response:
    status: 200
`;

async function workspaceWithFiles() {
  const root = await mkdtemp(join(tmpdir(), 'n8nt-workspace-'));
  await mkdir(join(root, 'onboarding'));
  await mkdir(join(root, 'empty'));
  await mkdir(join(root, '.runs'));
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'onboarding', 'echo.yaml'), SCENARIO);
  await writeFile(join(root, 'n8nt.config.yaml'), 'environments: {}\n');
  await writeFile(join(root, 'notes.txt'), 'not editable');
  await writeFile(join(root, '.env'), 'N8N_API_KEY=secret');
  await writeFile(join(root, '.runs', 'old.json'), '{}');
  await writeFile(join(root, 'node_modules', 'x.json'), '{}');

  return { root, workspace: await createWorkspace(root) };
}

describe('workspace', () => {
  it('lists editable files, folders first, skipping hidden and tool folders', async () => {
    const { workspace } = await workspaceWithFiles();

    assert.deepEqual(await workspace.tree(), [
      {
        name: 'onboarding',
        path: 'onboarding',
        type: 'folder',
        children: [{ name: 'echo.yaml', path: 'onboarding/echo.yaml', type: 'file' }],
      },
      { name: 'n8nt.config.yaml', path: 'n8nt.config.yaml', type: 'file' },
    ]);
  });

  it('reads and writes files inside the workspace', async () => {
    const { root, workspace } = await workspaceWithFiles();

    assert.equal(await workspace.read('onboarding/echo.yaml'), SCENARIO);
    await workspace.write('onboarding/new.yaml', 'name: x');
    assert.equal(await readFile(join(root, 'onboarding', 'new.yaml'), 'utf8'), 'name: x');
  });

  it('refuses paths outside the workspace', async () => {
    const { workspace } = await workspaceWithFiles();

    await assert.rejects(workspace.read('../outside.yaml'), { status: 403 });
    await assert.rejects(workspace.write('../../outside.yaml', 'x'), { status: 403 });
    await assert.rejects(workspace.resolvePath('..'), { status: 403 });
  });

  it('refuses files that are not YAML or JSON, like .env', async () => {
    const { workspace } = await workspaceWithFiles();

    await assert.rejects(workspace.read('.env'), { status: 400 });
    await assert.rejects(workspace.read('notes.txt'), { status: 400 });
    await assert.rejects(workspace.write('script.js', 'x'), { status: 400 });
  });

  it('reports missing files and folders as 404', async () => {
    const { workspace } = await workspaceWithFiles();

    await assert.rejects(workspace.read('missing.yaml'), { status: 404 });
    await assert.rejects(workspace.write('missing-folder/a.yaml', 'x'), { status: 404 });
  });
});

describe('validateDocument', () => {
  it('accepts a valid scenario', () => {
    assert.deepEqual(validateDocument('echo.yaml', SCENARIO), { valid: true });
  });

  it('reports YAML syntax errors', () => {
    const result = validateDocument('echo.yaml', 'name: [unclosed');
    assert.equal(result.valid, false);
  });

  it('checks scenarios against the schema', () => {
    const result = validateDocument('echo.yaml', 'name: Missing trigger\nworkflow: Echo\n');

    assert.equal(result.valid, false);
    assert.match(result.valid ? '' : result.errors.join('\n'), /steps.*trigger/);
  });

  it('checks the config file against the config schema, not the scenario one', () => {
    const config = 'environments:\n  local:\n    baseUrl: http://localhost:5678\n';

    assert.deepEqual(validateDocument('n8nt.config.yaml', config), { valid: true });
    assert.equal(validateDocument('sub/n8nt.config.yaml', 'nope: 1').valid, false);
  });

  it('only parses JSON fixtures', () => {
    assert.deepEqual(validateDocument('fixtures/a.json', '{"a": 1}'), { valid: true });
    assert.equal(validateDocument('fixtures/a.json', '{oops').valid, false);
  });
});
