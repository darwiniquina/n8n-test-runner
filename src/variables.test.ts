import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { interpolate, interpolateText, resolveVariables } from './variables.ts';

describe('interpolateText', () => {
  it('replaces placeholders inside text', () => {
    const text = interpolateText('employees/{{ id }}/{{name}}', {
      id: 42,
      name: 'ana',
    });

    assert.equal(text, 'employees/42/ana');
  });

  it('writes non-string values as JSON', () => {
    assert.equal(interpolateText('tags={{ tags }}', { tags: ['a'] }), 'tags=["a"]');
  });
});

describe('interpolate', () => {
  it('keeps the type when the whole string is one placeholder', () => {
    assert.equal(interpolate('{{ count }}', { count: 3 }), 3);
    assert.deepEqual(interpolate('{{ user }}', { user: { id: 1 } }), { id: 1 });
  });

  it('walks nested objects and arrays, leaving keys alone', () => {
    const value = interpolate(
      { '{{ key }}': ['{{ a }}', 'x-{{ a }}'], n: 5 },
      { a: 1, key: 'unused' },
    );

    assert.deepEqual(value, { '{{ key }}': [1, 'x-1'], n: 5 });
  });

  it('throws on unknown variables instead of using an empty string', () => {
    assert.throws(() => interpolate('{{ missing }}', {}), /Unknown variable/);
  });

  it('gives a new $uuid on every reference', () => {
    const [first, second] = interpolate(['{{ $uuid }}', '{{ $uuid }}'], {}) as string[];

    assert.match(first, /^[0-9a-f-]{36}$/);
    assert.notEqual(first, second);
  });
});

describe('resolveVariables', () => {
  it('resolves in order, so later variables can use earlier ones', () => {
    const variables = resolveVariables(
      { id: '{{ $uuid }}', email: 'test+{{ id }}@example.com' },
      { domain: 'example.com' },
    );

    assert.equal(variables.email, `test+${variables.id}@example.com`);
    assert.equal(variables.domain, 'example.com');
  });
});
