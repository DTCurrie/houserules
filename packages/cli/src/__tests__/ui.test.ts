import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as clack from '@clack/prompts';

import {
  chooseMigrationOption,
  optionPromptMessage,
  renderPreview,
  selectModules,
  wrap,
} from '../ui.js';

import type { ModuleDef } from '@houserules/api';
import type { Ctx } from '../detect.js';
import type { MigrationFinding } from '../core/migration-preverify.js';
import type { Effect } from '../plan.js';
import type { RegisteredModule } from '../plugin-registry.js';

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (value: string) => value.replace(ANSI, '');

function registered(id: string, alias: string | null): RegisteredModule {
  const def: ModuleDef = {
    id,
    title: `${id} title`,
    group: 'optional',
    hint: () => id,
    defaultEnabled: () => true,
    plan: () => [],
  };
  if (alias === null) return { id, def, source: null };
  return {
    id: `${alias}/${id}`,
    def,
    source: {
      name: `@houserules/plugin-${alias}`,
      alias,
      version: '1.0.0',
      dir: '/x',
    },
  };
}

describe('wrap', () => {
  it('breaks a plain line at the last word that fits', () => {
    expect(wrap('alpha beta gamma', 11)).toBe('alpha beta\ngamma');
  });

  it('lets a single over-long token overflow rather than splitting it', () => {
    expect(wrap('/a/very/long/absolute/path', 8)).toBe(
      '/a/very/long/absolute/path',
    );
  });

  it('keeps a bullet marker on the same line as an item too long to fit', () => {
    expect(wrap('- /a/very/long/absolute/path', 8)).toBe(
      '- /a/very/long/absolute/path',
    );
  });

  it('keeps a numbered marker on the same line as an item too long to fit', () => {
    expect(wrap('1. /a/very/long/absolute/path', 8)).toBe(
      '1. /a/very/long/absolute/path',
    );
  });

  it('hangs a wrapped list item under its text rather than under the marker', () => {
    expect(wrap('- alpha beta gamma delta', 12)).toBe(
      '- alpha beta\n  gamma\n  delta',
    );
  });

  it('preserves the existing indent of an indented list item', () => {
    expect(wrap('  - /a/very/long/absolute/path', 8)).toBe(
      '  - /a/very/long/absolute/path',
    );
  });

  it('treats a hyphen with no following item as ordinary text', () => {
    expect(wrap('alpha - beta', 40)).toBe('alpha - beta');
  });
});

describe('optionPromptMessage', () => {
  it('names the module and its plugin ahead of the question', () => {
    const message = optionPromptMessage(
      registered('chrome-devtools-mcp', 'design'),
      'Install the slim variant?',
    );

    expect(plain(message)).toBe(
      'chrome-devtools-mcp [design]  Install the slim variant?',
    );
  });

  it('names a built-in module with no plugin tag', () => {
    const message = optionPromptMessage(
      registered('code-cleanliness', null),
      'Which guides?',
    );

    expect(plain(message)).toBe('code-cleanliness  Which guides?');
  });
});

describe('renderPreview, given a region effect', () => {
  const region = (body: string, op: Effect['op'], previousBody?: string) =>
    ({
      action: {
        kind: 'region',
        module: 'core',
        dest: 'CLAUDE.md',
        body,
        reason: 'test',
      },
      op,
      content: null,
      ...(previousBody === undefined ? {} : { previousBody }),
    }) as unknown as Effect;
  const render = (effect: Effect) =>
    plain(renderPreview({ effects: [effect], settingsPlan: null })).split('\n');
  const numbered = (lineCount: number, prefix: string) =>
    Array.from({ length: lineCount }, (_, i) => `${prefix}${i}`).join('\n');

  it('prints one added line and nothing else under the entry', () => {
    const out = render(region('- a\n- b', 'update', '- a'));
    expect(out.slice(1)).toEqual(['    + - b']);
  });

  it('prints a removed line and an added line, added first', () => {
    const out = render(region('- a\n- c', 'update', '- a\n- b'));
    expect(out.slice(1)).toEqual(['    + - c', '    - - b']);
  });

  it('caps at ten lines and counts the remainder', () => {
    const out = render(region(numbered(15, 'n'), 'update', 'old'));
    expect(out.slice(1)).toHaveLength(11);
    expect(out[1]).toBe('    + n0');
    expect(out[10]).toBe('    + n9');
    expect(out[11]).toBe('    … 6 more changed line(s)');
  });

  it('prints exactly ten lines with no overflow line', () => {
    const out = render(region(numbered(10, 'n'), 'update', ''));
    expect(out.slice(1)).toHaveLength(10);
    expect(out.join('\n')).not.toContain('more changed');
  });

  it('prints 15 changed lines as ten plus a remainder of five', () => {
    const out = render(region(numbered(15, 'n'), 'update', ''));
    expect(out[11]).toBe('    … 5 more changed line(s)');
  });

  it('prints a skip-identical region as a single entry line', () => {
    expect(render(region('x', 'skip-identical', 'x'))).toEqual([
      '= CLAUDE.md (managed block)',
    ]);
  });

  it('prints an update with no previousBody as a single entry line', () => {
    expect(render(region('x', 'update'))).toEqual([
      '~ CLAUDE.md (managed block)',
    ]);
  });
});

vi.mock('@clack/prompts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@clack/prompts')>()),
  multiselect: vi.fn(),
  select: vi.fn(),
  isCancel: vi.fn(() => false),
}));

describe('selectModules with a required module', () => {
  const modules = ['core', 'orchestrate', 'sweep'].map((id) =>
    registered(id, null),
  );
  const requiredBy = { sweep: 'orchestrate' };
  const close = (ids: string[]) =>
    ids.includes('orchestrate') && !ids.includes('sweep')
      ? [...ids, 'sweep']
      : ids;
  const ctx = {} as Ctx;

  beforeEach(() => {
    vi.mocked(clack.multiselect).mockReset();
  });

  it('labels the required module with its requirer', async () => {
    vi.mocked(clack.multiselect).mockResolvedValue(['core', 'orchestrate']);

    await selectModules(modules, ctx, ['core'], requiredBy, close);

    const options = vi.mocked(clack.multiselect).mock.calls[0]![0].options;
    expect(
      options.find((option) => option.value === 'orchestrate')!.label,
    ).toBe('orchestrate title');
    expect(options.find((option) => option.value === 'sweep')!.label).toContain(
      '(required by orchestrate)',
    );
  });

  it('re-adds a deselected required module while its requirer stays', async () => {
    vi.mocked(clack.multiselect).mockResolvedValue(['core', 'orchestrate']);

    const ids = await selectModules(modules, ctx, ['core'], requiredBy, close);

    expect(ids).toEqual(['core', 'orchestrate', 'sweep']);
  });

  it('drops the required module when its requirer is deselected too', async () => {
    vi.mocked(clack.multiselect).mockResolvedValue(['core', 'sweep']);

    const ids = await selectModules(modules, ctx, ['core'], requiredBy, close);

    expect(ids).toEqual(['core']);
  });
});

describe('chooseMigrationOption', () => {
  const finding: MigrationFinding = {
    kind: 'mass-misread',
    message: '3 of 4 files read as edited',
    paths: ['a'],
    options: [
      { choice: 'stop', label: 'stop label', flag: null },
      { choice: 'force', label: 'force label', flag: '--force' },
    ],
  };

  beforeEach(() => {
    vi.mocked(clack.select).mockReset();
  });

  it('offers the finding options with stop preselected and returns the pick', async () => {
    vi.mocked(clack.select).mockResolvedValue('force');

    await expect(chooseMigrationOption(finding)).resolves.toBe('force');

    expect(vi.mocked(clack.select).mock.calls[0]![0]).toMatchObject({
      message: '3 of 4 files read as edited',
      initialValue: 'stop',
      options: [
        { value: 'stop', label: 'stop label' },
        { value: 'force', label: 'force label' },
      ],
    });
  });

  it('exits 1 on a cancel', async () => {
    vi.mocked(clack.select).mockResolvedValue(Symbol('cancel'));
    vi.mocked(clack.isCancel).mockReturnValueOnce(true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);

    await expect(chooseMigrationOption(finding)).rejects.toThrow('exit');

    expect(exit).toHaveBeenCalledWith(1);
    vi.restoreAllMocks();
  });
});
