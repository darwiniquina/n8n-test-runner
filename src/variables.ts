import { randomUUID } from 'node:crypto';

export type Variables = Record<string, unknown>;

// Names users can define. Built-ins start with "$" so they never collide.
export const VARIABLE_NAME = /^[A-Za-z_]\w*$/;

const PLACEHOLDER = /\{\{\s*([$\w]+)\s*\}\}/g;
const WHOLE_PLACEHOLDER = /^\{\{\s*([$\w]+)\s*\}\}$/;

// Evaluated on every reference, like Postman's {{$guid}}. To reuse one value,
// assign it to a variable first.
const BUILT_INS: Record<string, () => unknown> = {
  $uuid: () => randomUUID(),
  $now: () => new Date().toISOString(),
};

function lookup(name: string, variables: Variables) {
  const builtIn = BUILT_INS[name];
  if (builtIn) {
    return builtIn();
  }

  if (Object.hasOwn(variables, name)) {
    return variables[name];
  }

  // An empty string would hide typos and send wrong data to n8n.
  throw new Error(`Unknown variable "{{ ${name} }}".`);
}

// Always returns a string. Use it for URL paths, query values and headers.
export function interpolateText(text: string, variables: Variables): string {
  return text.replace(PLACEHOLDER, (_match, name: string) => {
    const value = lookup(name, variables);
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

// Walks objects and arrays. A string that is exactly one placeholder keeps the
// variable's type (number, object), so "{{ count }}" can still equal 3.
export function interpolate(value: unknown, variables: Variables): unknown {
  if (typeof value === 'string') {
    const whole = value.match(WHOLE_PLACEHOLDER);
    return whole ? lookup(whole[1], variables) : interpolateText(value, variables);
  }

  if (Array.isArray(value)) {
    return value.map((item) => interpolate(item, variables));
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolate(item, variables)]),
    );
  }

  return value;
}

// Definitions resolve in order, so a variable can use the ones before it.
export function resolveVariables(
  definitions: Variables,
  base: Variables = {},
): Variables {
  const variables = { ...base };

  for (const [name, value] of Object.entries(definitions)) {
    variables[name] = interpolate(value, variables);
  }

  return variables;
}
