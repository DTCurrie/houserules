import { readFileSync } from 'node:fs';

export function longest(path) {
  const lines = readFileSync(path, 'utf8').split('\n');
  return lines.reduce(
    (best, line) => (line.length > best.length ? line : best),
    '',
  );
}
