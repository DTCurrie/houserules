import js from '@eslint/js';
import globals from 'globals';
import ts from 'typescript-eslint';

const baseConfig = ts.config(
  {
    ignores: [
      '.claude/',
      '**/dist/',
      '**/payload-dist/',
      '**/coverage/',
      '**/.wireit/',
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  // Every TypeScript source gets the typed rule set. payload/ is authored as .mts —
  // that extension has to be listed explicitly or ESLint matches nothing and the
  // shipping hook scripts go silently unlinted.
  {
    files: [
      'packages/*/src/**/*.ts',
      'packages/*/test/**/*.ts',
      'packages/*/payload/**/*.mts',
      'packages/*/payload/**/__test__/**/*.ts',
      'packages/*/*.ts',
      '*.ts',
    ],
    extends: [ts.configs.recommended],
    rules: {
      // typescript-eslint's own guidance for TS sources: tsc already does this,
      // and the rule misfires on ambient/global declarations.
      'no-undef': 'off',
      // A command that takes (dir, flags) but reads only `dir` still has to declare
      // the parameter for the shared signature — `_`-prefixed marks that deliberate.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Measured against this workspace in PROBE-eslint.md: 0 findings, so both fire
      // clean at error. `no-unreachable` ships in eslint:recommended already; listed
      // here to record the decision. naming-convention is restricted to the two
      // selectors that need no type information — the repo has no root tsconfig.json,
      // so a type-aware selector (booleans) cannot run without configuring
      // parserOptions.project first, which PROBE-eslint.md left unmeasured.
      'no-unreachable': 'error',
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'typeLike', format: ['PascalCase'] },
        {
          selector: 'typeParameter',
          format: ['PascalCase'],
          prefix: ['T'],
        },
      ],
      // Kept at the default of 4. Raising it to 5 to accommodate the four sites this
      // repo held would have left a rule that catches nothing until someone writes
      // six-deep, which is the defect this rule exists to prevent. The four sites were
      // fixed instead.
      'max-depth': ['error', 4],
    },
  },
  // Tests drive the CLI through JSON artifacts on disk and deliberately poke
  // arbitrary shapes into them — a suite asserting houserules tolerates an unknown
  // settings key cannot type that key as part of Settings. `any` in a test helper
  // is that intent, not a gap; src/ stays strict.
  //
  // `packages/test/src/**` is the one src/ tree that qualifies. The whole package is
  // testing infrastructure, and it keeps that infrastructure under src/ only because it is
  // published for plugin authors to build their own suites on. Every other src/ stays strict.
  {
    files: [
      'packages/*/test/**/*.ts',
      'packages/*/src/**/__test__/**/*.ts',
      'packages/*/payload/**/__test__/**/*.ts',
      'packages/test/src/**/*.ts',
    ],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  // The payload package's lib suites must exercise source, not build output. Importing
  // from payload-dist/ means a source edit tests stale bytes until the next build, which
  // let a broken probe pass green (board issue 90).
  {
    files: ['packages/payload/payload/scripts/lib/__test__/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['*payload-dist*'],
              message:
                'Import the .mts source (../<lib>.mjs), not payload-dist build output. Build output goes stale between rebuilds.',
            },
          ],
        },
      ],
    },
  },
);

export default baseConfig;

// `max-lines-per-function` measured 447 findings across 184 files in
// PROBE-eslint.md: turning it on repo-wide at any severity would print 447
// warnings on every `pnpm lint` forever, training readers to skim past the
// warning block instead of reading it, the same failure the precision floor
// exists to prevent one level up. code-cleanliness.md's own wording, "past 20
// to 30 lines, look again", is a HYBRID candidate-finder for a model to judge,
// not a MECHANICAL pass/fail, so it belongs at `warn`, scoped to a diff, never
// in the default config `pnpm lint` runs.
//
// The ESLint CLI's `--config` flag always reads a file's DEFAULT export, so this
// named export needs the Node API rather than the CLI to run standalone. Over the
// files changed in the working tree:
//
//   node -e "
//   import('eslint').then(async ({ ESLint }) => {
//     const { changedFilesConfig } = await import('./eslint.config.mjs');
//     const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: changedFilesConfig });
//     const results = await eslint.lintFiles(process.argv.slice(1));
//     console.log((await eslint.loadFormatter('stylish')).format(results));
//   });
//   " -- $(git diff --name-only -- '*.ts' '*.mts')
export const changedFilesConfig = ts.config(...baseConfig, {
  files: [
    'packages/*/src/**/*.ts',
    'packages/*/test/**/*.ts',
    'packages/*/payload/**/*.mts',
    'packages/*/payload/**/__test__/**/*.ts',
    'packages/*/*.ts',
    '*.ts',
  ],
  rules: {
    'max-lines-per-function': 'warn',
  },
});
