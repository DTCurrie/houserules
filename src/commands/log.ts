/** Human commentary. Always stderr, so `--json` keeps stdout to the document alone. */
export function message(text: string): void {
  console.log(text);
}

export function indent(spaces: number, text: string): void {
  const pad = ' '.repeat(spaces);
  console.log(
    text
      .split('\n')
      .map((line) => pad + line)
      .join('\n'),
  );
}

export function line(text: string): void {
  console.log(`\n${text}`);
}

export function error(value: string | Error): void {
  console.error(value instanceof Error ? value.message : value);
}

/** The only thing that may reach stdout when `--json` is set. */
export function json(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
