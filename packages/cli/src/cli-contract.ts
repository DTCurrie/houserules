/** The parsed invocation every command receives. */
export interface Flags {
  dryRun: boolean;
  yes: boolean;
  modules: string;
  force: boolean;
  nextSteps: boolean;
  /** `modules` only: comma-separated ids to withdraw from the install. */
  disable: string;
  /** `init`/`modules` only: repeated `id=value1,value2` module option overrides. */
  moduleOption?: string[];
  /** `doctor` only: reconcile the drift found, instead of only reporting it. */
  fix: boolean;
  /** `doctor --fix` only: also delete orphaned kit files. */
  prune: boolean;
  /** Machine-readable output on stdout. Human text goes to stderr. */
  json: boolean;
  kitVersion: string;
}

/**
 * The exit-code contract, printed in `--help` and asserted in `src/__test__/cli.test.ts`.
 * There is deliberately no "refused to overwrite" code: `init` on an existing
 * install re-plans from the recorded module set rather than refusing.
 */
export const EXIT = {
  ok: 0,
  /** A command failed, or `doctor` found an ERROR-level problem. */
  error: 1,
  /** `.claude/kit.config.json` does not satisfy the schema. */
  badConfig: 2,
} as const;
