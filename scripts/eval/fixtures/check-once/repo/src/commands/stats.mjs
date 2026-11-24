import { countFile } from '../count.mjs';

export function stats(path) {
  const { lines, words } = countFile(path);
  return { lines, words, wordsPerLine: lines === 0 ? 0 : words / lines };
}
