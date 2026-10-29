import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkPaths, getPath, matches } from './assertions.ts';

describe('getPath', () => {
  const value = { user: { emails: ['a@example.com'] }, items: [{ id: 7 }] };

  it('reads dotted and indexed paths', () => {
    assert.equal(getPath(value, 'user.emails[0]'), 'a@example.com');
    assert.equal(getPath([{ id: 7 }], '[0].id'), 7);
  });

  it('treats an empty path or $ as the root', () => {
    assert.equal(getPath(value, ''), value);
    assert.equal(getPath(value, '$'), value);
    assert.equal(getPath(value, '$.items[0].id'), 7);
  });

  it('returns undefined for missing paths instead of throwing', () => {
    assert.equal(getPath(value, 'user.name.first'), undefined);
    assert.equal(getPath(null, 'anything'), undefined);
  });
});

describe('matches', () => {
  it('compares literals with deep equality', () => {
    assert.ok(matches({ a: [1, 2] }, { a: [1, 2] }));
    assert.ok(!matches('1', 1));
  });

  it('supports matcher operators', () => {
    assert.ok(matches('hello world', { $contains: 'world' }));
    assert.ok(matches(['a', 'b'], { $contains: 'b' }));
    assert.ok(matches('INV-0042', { $matches: '^INV-\\d+$' }));
    assert.ok(matches(undefined, { $exists: false }));
    assert.ok(matches([], { $type: 'array' }));
    assert.ok(matches(5, { $gt: 1, $lt: 10 }));
    assert.ok(!matches(5, { $gt: 1, $lt: 3 }));
  });

  it('treats objects without $ keys as literal values', () => {
    assert.ok(matches({ status: 'ok' }, { status: 'ok' }));
    assert.ok(!matches({ status: 'ok', extra: 1 }, { status: 'ok' }));
  });

  it('rejects unknown operators loudly', () => {
    assert.throws(() => matches('x', { $startsWith: 'x' }), /Unknown matcher/);
  });
});

describe('checkPaths', () => {
  it('reports expected and actual for each path', () => {
    const [check] = checkPaths('body', { echo: 'hi' }, { echo: 'hello' });

    assert.deepEqual(check, {
      label: 'body echo',
      passed: false,
      expected: 'hello',
      actual: 'hi',
    });
  });
});
