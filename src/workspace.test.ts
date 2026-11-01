import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
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

  it('refuses symlinks that point outside the workspace or at non-editable files', async (t) => {
    const { root, workspace } = await workspaceWithFiles();
    const outside = join(root, '..', `outside-${Date.now()}.yaml`);
    await writeFile(outside, 'original');

    try {
      await symlink(outside, join(root, 'out.yaml'), 'file');
      await symlink(join(root, '.env'), join(root, 'env.yaml'), 'file');
      await symlink(join(root, '..', 'missing.yaml'), join(root, 'dangling.yaml'), 'file');
    } catch {
      // Windows without Developer Mode cannot create symlinks.
      t.skip('symlinks not permitted');
      return;
    }

    await assert.rejects(workspace.write('out.yaml', 'x'), { status: 403 });
    assert.equal(await readFile(outside, 'utf8'), 'original');
    await assert.rejects(workspace.read('env.yaml'), { status: 400 });
    await assert.rejects(workspace.write('dangling.yaml', 'x'), { status: 403 });
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
    assert.match(result.valid ? '' : result.errors[0].message, /steps.*trigger/);
  });

  it('points schema errors at the YAML that caused them', () => {
    const content = SCENARIO.replace('    status: 200', '    status: "ok"\n  respons: {}');
    const result = validateDocument('echo.yaml', content);
    assert.equal(result.valid, false);

    const marked = (result.valid ? [] : result.errors).map((error) =>
      content.slice(error.from, error.to),
    );
    assert.deepEqual(marked.sort(), ['"ok"', 'respons']);
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
