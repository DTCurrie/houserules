import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';

const PLUGIN_DESIGN = fileURLToPath(new URL('../..', import.meta.url));
const API_README = fileURLToPath(
  new URL('../../../api/README.md', import.meta.url),
);

const API_ENTRY = fileURLToPath(
  new URL('../../../api/dist/index.js', import.meta.url),
);

const README_TRIGGER_EXPRESSION = "hasModule(answers.moduleIds, 'design')";
const TRIGGER_LINE = '- Building UI? Take tokens from the design module.';

function writeFixturePlugin(triggerExpression: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'readme-example-'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: '@houserules/plugin-readme-example',
      version: '1.0.0',
      private: true,
      main: 'index.cjs',
    }),
  );
  writeFileSync(
    join(dir, 'index.cjs'),
    `const { hasModule } = require(${JSON.stringify(API_ENTRY)});

module.exports = function readmeExample(api) {
  return [
    {
      id: 'my-rule',
      title: 'My Rule',
      group: 'optional',
      hint: () => 'the README example module',
      defaultEnabled: () => false,
      requires: [{ id: 'design', package: '@houserules/plugin-design' }],
      skillTriggers: (answers) =>
        ${triggerExpression}
          ? ['${TRIGGER_LINE}']
          : [],
      plan: () => [],
    },
  ];
};
`,
  );
  return dir;
}

function installedClaudeMd(
  designAlias: string,
  triggerExpression: string,
): string {
  const root = useInstalledRepo('pnpm-monorepo', {
    modules: 'ex/my-rule',
    plugins: [
      { name: writeFixturePlugin(triggerExpression), alias: 'ex' },
      { name: PLUGIN_DESIGN, alias: designAlias },
    ],
  });
  return readFileSync(join(root, '.claude/houserules.md'), 'utf8');
}

describe('the @houserules/api README skillTriggers example', () => {
  it('uses the expression this test runs, byte for byte', () => {
    const readme = readFileSync(API_README, 'utf8');

    expect(readme).toContain(README_TRIGGER_EXPRESSION);
  });

  it.each(['design', 'ui-kit'])(
    'fires for the requirement it declares when plugin-design is aliased %s',
    (designAlias) => {
      const claudeMd = installedClaudeMd(
        designAlias,
        README_TRIGGER_EXPRESSION,
      );

      expect(claudeMd).toContain(TRIGGER_LINE);
    },
  );

  it('does not fire under an alias other than the one the old example hardcoded', () => {
    const claudeMd = installedClaudeMd(
      'ui-kit',
      'answers.moduleIds.includes(`${api.alias}/design`)',
    );

    expect(claudeMd, 'old expression must stay silent').not.toContain(
      TRIGGER_LINE,
    );
  });
});
