/** The only thing that may reach stdout when `--json` is set. */
export function json(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
