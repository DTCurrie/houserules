/**
 * Every suite `run.mjs` can measure, keyed by the name `--suite` takes. Each value loads the
 * suite module on demand, so a run of one suite never imports the others.
 */
export const SUITES = {
  hooks: () => import('./hooks.mjs'),
  cli: () => import('./cli.mjs'),
  scripts: () => import('./scripts.mjs'),
};
