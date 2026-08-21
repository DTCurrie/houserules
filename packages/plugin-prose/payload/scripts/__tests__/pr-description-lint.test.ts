import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { runIn, runScript } from '#test/run';
import { editHouseConfig } from '#test/installed-tree';

const LINT = '.claude/scripts/pr-description-lint.mjs';
const PLUGIN_DIR = fileURLToPath(new URL('../../..', import.meta.url));

function stage(): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'prose/pr-description',
    plugins: [{ name: PLUGIN_DIR, alias: 'prose' }],
  });
}

function wrap(body: string, backticks = 3): string {
  const fence = '`'.repeat(backticks);
  return `${fence}\n${body}\n${fence}`;
}

function lint(root: string, output: string, ...args: string[]) {
  return runScript(root, LINT, { input: output, args });
}

function insertBeforeTesting(body: string, section: string): string {
  return body.replace('### Testing', `${section}\n\n### Testing`);
}

const VALID_BODY = `Adds a ghost variant to Button so consumers get a low-emphasis style.

### Cityville

- \`Button\` adds a \`variant="ghost"\` value.

### Testing

Ran \`pnpm test\`.`;

describe('pr-description-lint.mjs fenced wrapper', () => {
  it('exits 0 with no findings for a well-formed wrapped description', () => {
    const root = stage();

    const r = lint(root, wrap(VALID_BODY));

    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain('No findings.');
  });

  it('errors when the description is not wrapped in a fenced code block', () => {
    const root = stage();

    const r = lint(root, VALID_BODY);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('[pr-description/fenced-wrapper]');
  });

  it('errors when a nested fenced block sits inside an outer fence of only three backticks', () => {
    const root = stage();
    const body = insertBeforeTesting(
      VALID_BODY,
      '### Snippet\n\n```ts\nconst x = 1;\n```',
    );

    const r = lint(root, wrap(body, 3));

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('[pr-description/fenced-wrapper]');
  });

  it('accepts a nested fenced block once the outer fence uses four backticks', () => {
    const root = stage();
    const body = insertBeforeTesting(
      VALID_BODY,
      '### Snippet\n\n```ts\nconst x = 1;\n```',
    );

    const r = lint(root, wrap(body, 4));

    expect(r.status, r.stdout).toBe(0);
  });
});

describe('pr-description-lint.mjs structure', () => {
  it('errors on a ## Summary wrapper heading', () => {
    const root = stage();
    const body = `## Summary\n\n${VALID_BODY}`;

    const r = lint(root, wrap(body));

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('[pr-description/no-wrapper-heading]');
  });

  it('errors on a section heading that is not ###', () => {
    const root = stage();
    const body = VALID_BODY.replace('### Testing', '## Testing');

    const r = lint(root, wrap(body));

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('[pr-description/heading-level]');
  });

  it('errors when Testing is not the last section', () => {
    const root = stage();
    const body = `Adds a ghost variant.\n\n### Testing\n\nRan \`pnpm test\`.\n\n### Cityville\n\n- \`Button\` adds a variant.`;

    const r = lint(root, wrap(body));

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('[pr-description/testing-not-last]');
  });

  it('warns without failing when the opening paragraph runs more than two sentences', () => {
    const root = stage();
    const body = `One. Two. Three sentences here.\n\n### Testing\n\nRan \`pnpm test\`.`;

    const r = lint(root, wrap(body));

    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain('[pr-description/opening-length]');
  });
});

describe('pr-description-lint.mjs banned phrases', () => {
  it('errors on "updated the package"', () => {
    const root = stage();
    const body = `Updated the package to add a feature.\n\n### Testing\n\nRan \`pnpm test\`.`;

    const r = lint(root, wrap(body));

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('[pr-description/banned-phrase]');
  });

  it('errors on "tests pass" naming no command', () => {
    const root = stage();
    const body = `${VALID_BODY}`.replace('Ran `pnpm test`.', 'Tests pass.');

    const r = lint(root, wrap(body));

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('[pr-description/banned-phrase]');
  });
});

describe('pr-description-lint.mjs changelog-shaped content', () => {
  it('warns without failing on a Files Changed heading', () => {
    const root = stage();
    const body = insertBeforeTesting(
      VALID_BODY,
      '### Files Changed\n\n- a\n- b',
    );

    const r = lint(root, wrap(body));

    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain('[pr-description/changelog-pattern-candidate]');
  });

  it('warns without failing on a git diff --stat shaped line', () => {
    const root = stage();
    const body = insertBeforeTesting(
      VALID_BODY,
      '### Cityville\n\n src/game.ts | 4 ++--',
    );

    const r = lint(root, wrap(body));

    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain('[pr-description/changelog-pattern-candidate]');
  });

  it('does not warn on an ordinary bulleted layer section', () => {
    const root = stage();

    const r = lint(root, wrap(VALID_BODY));

    expect(r.stdout).not.toContain('changelog-pattern-candidate');
  });
});

describe('pr-description-lint.mjs verify commands', () => {
  it("errors when the Testing section quotes none of this repo's verify commands", () => {
    const root = stage();
    editHouseConfig(root, (config) => {
      config.targets[0].verifyCommands = ['pnpm --filter cityville test'];
    });

    const r = lint(root, wrap(VALID_BODY));

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('[pr-description/verify-commands-missing]');
  });

  it('passes once the Testing section names a configured verify command', () => {
    const root = stage();
    editHouseConfig(root, (config) => {
      config.targets[0].verifyCommands = ['pnpm test'];
    });

    const r = lint(root, wrap(VALID_BODY));

    expect(r.stdout).not.toContain('verify-commands-missing');
  });
});

describe('pr-description-lint.mjs layer headings', () => {
  it("warns without failing on a heading matching none of this repo's targets", () => {
    const root = stage();
    const body = VALID_BODY.replace('### Cityville', '### Components');

    const r = lint(root, wrap(body));

    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain('[pr-description/unrecognized-layer-heading]');
  });

  it('does not warn on a heading matching a configured target', () => {
    const root = stage();

    const r = lint(root, wrap(VALID_BODY));

    expect(r.stdout).not.toContain('unrecognized-layer-heading');
  });
});

describe('pr-description-lint.mjs base', () => {
  it('resolves to the current default branch when only one exists', () => {
    const root = stage();

    const r = runScript(root, LINT, { args: ['base'] });

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('main');
  });

  it('resolves to a renamed branch once main no longer exists', () => {
    const root = stage();
    runIn(root, 'git', ['branch', '-m', 'master']);

    const r = runScript(root, LINT, { args: ['base'] });

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('master');
  });
});
