// Plain output helpers for the non-interactive paths (claude-kit CLI).
//
// `ui.ts` (clack) owns the interactive install; this owns everything that has to be
// readable in a CI log or piped through jq. The split that matters: under `--json`
// stdout carries ONLY the JSON document, so any human commentary goes to stderr.

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
