import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function countFile(path) {
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n').filter((line) => line !== '').length;
  const words = text.split(/\s+/).filter((word) => word !== '').length;
  return { lines, words };
}

export function reportAll(dir, format) {
  const rows = readdirSync(dir)
    .filter((name) => name.endsWith('.txt'))
    .sort()
    .map((name) => ({ file: name, ...countFile(join(dir, name)) }));
  if (format === 'json') return JSON.stringify(rows, null, 2);
  return rows
    .map((row) => `${row.file}: ${row.lines} lines, ${row.words} words`)
    .join('\n');
}
