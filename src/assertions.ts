import { isDeepStrictEqual } from 'node:util';

export type Check = {
  label: string;
  passed: boolean;
  expected?: unknown;
  actual?: unknown;
};

// "user.emails[0]" -> ["user", "emails", "0"]. An empty path or "$" is the root.
export function getPath(value: unknown, path: string): unknown {
  const keys = path.replace(/^\$\.?/, '').match(/[^.[\]]+/g) ?? [];
  let current = value;

  for (const key of keys) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }

    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

function typeName(value: unknown) {
  if (value === null) {
    return 'null';
  }

  return Array.isArray(value) ? 'array' : typeof value;
}

// An object whose keys all start with "$" is a matcher, anything else is a
// literal value compared with deep equality.
function isMatcher(expected: unknown): expected is Record<string, unknown> {
  if (expected === null || typeof expected !== 'object') {
    return false;
  }

  if (Array.isArray(expected)) {
    return false;
  }

  const keys = Object.keys(expected);
  return keys.length > 0 && keys.every((key) => key.startsWith('$'));
}

function matchOperator(operator: string, actual: unknown, argument: unknown) {
  switch (operator) {
    case '$exists':
      return (actual !== undefined) === argument;

    case '$type':
      return typeName(actual) === argument;

    case '$contains':
      if (typeof actual === 'string') {
        return actual.includes(String(argument));
      }

      return (
        Array.isArray(actual) &&
        actual.some((item) => isDeepStrictEqual(item, argument))
      );

    case '$matches':
      return typeof actual === 'string' && new RegExp(String(argument)).test(actual);

    case '$gt':
      return typeof actual === 'number' && actual > Number(argument);

    case '$lt':
      return typeof actual === 'number' && actual < Number(argument);

    default:
      throw new Error(`Unknown matcher "${operator}"`);
  }
}

export function matches(actual: unknown, expected: unknown): boolean {
  if (!isMatcher(expected)) {
    return isDeepStrictEqual(actual, expected);
  }

  return Object.entries(expected).every(([operator, argument]) =>
    matchOperator(operator, actual, argument),
  );
}

export function checkPaths(
  labelPrefix: string,
  root: unknown,
  expectations: Record<string, unknown>,
): Check[] {
  return Object.entries(expectations).map(([path, expected]) => {
    const actual = getPath(root, path);

    return {
      label: `${labelPrefix} ${path}`,
      passed: matches(actual, expected),
      expected,
      actual,
    };
  });
}
