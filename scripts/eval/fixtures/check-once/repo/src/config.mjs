import { existsSync, readFileSync } from 'node:fs';

const DEFAULTS = {
  dataDir: 'data',
  extensions: ['.txt'],
  ignore: [],
  wordPattern: '\\s+',
};

export function loadConfig(path = 'tally.config.json') {
  if (!existsSync(path)) return { ...DEFAULTS };
  return { ...DEFAULTS, ...JSON.parse(readFileSync(path, 'utf8')) };
}
