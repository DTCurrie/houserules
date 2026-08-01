import js from '@eslint/js';
import globals from 'globals';
import ts from 'typescript-eslint';

export default ts.config(
  { ignores: ['.claude/', 'dist/', 'payload-dist/', 'coverage/'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  // payload/ is hand-authored .mjs until phase 6 of the kit-v2 plan; it gets the JS
  // rules only. src/ and test/ are TypeScript and get the typed rule set.
  {
    files: ['src/**/*.ts', 'test/**/*.ts', '*.ts'],
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
    },
  },
  // Tests drive the CLI through JSON artifacts on disk and deliberately poke
  // arbitrary shapes into them — a suite asserting the kit tolerates an unknown
  // settings key cannot type that key as part of Settings. `any` in a test helper
  // is that intent, not a gap; src/ stays strict.
  {
    files: ['test/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
