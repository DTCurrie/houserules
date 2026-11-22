/** `path` as one POSIX shell word, single-quoted only when it holds a character the shell reads. */
export function shellWord(path: string): string {
  return /^[\w./@+=-]+$/.test(path)
    ? path
    : `'${path.replaceAll("'", `'\\''`)}'`;
}
