import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { useRepo } from '#test/repo';
import { detect } from '../../../detect.js';
import { checkInstructionsFile } from '../instructions-file.js';

const REGION =
  '# Repo\n\n<!-- houserules:claude-md start -->\nrules\n<!-- houserules:claude-md end -->\n';

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function settingsWith(pluginId: string, value: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'kit-user-settings-'));
  const path = join(dir, 'settings.json');
  writeFileSync(
    path,
    JSON.stringify({
      pluginConfigs: { [pluginId]: { options: { instructionFiles: value } } },
    }),
  );
  return path;
}

function noSettings(): string {
  return join(
    mkdtempSync(join(tmpdir(), 'kit-user-settings-')),
    'settings.json',
  );
}

function run(root: string, userSettingsPath: string) {
  return checkInstructionsFile(root, detect(root), userSettingsPath);
}

function expectQuiet(r: ReturnType<typeof run>): void {
  expect(r.findings).toHaveLength(0);
  expect(r.readouts.join('\n')).toMatch(/AGENTS\.md/);
}

describe('checkInstructionsFile', () => {
  it.each(['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'])(
    'warns once, naming %s, when it silences an AGENTS.md carrying the block',
    (file) => {
      const root = useRepo('pnpm-single');
      write(root, 'AGENTS.md', REGION);
      write(root, file, '# mine\n');

      const r = run(root, noSettings());

      expect(r.findings).toHaveLength(1);
      expect(r.findings[0]?.level).toBe('WARN');
      expect(r.findings[0]?.msg).toContain(file);
      expect(r.findings[0]?.msg).toContain('@AGENTS.md');
      expect(r.findings[0]?.msg).toContain('claude-md-and-agents-md');
    },
  );

  it('is quiet for an AGENTS.md with the block and no CLAUDE.md', () => {
    const root = useRepo('pnpm-single');
    write(root, 'AGENTS.md', REGION);

    expectQuiet(run(root, noSettings()));
  });

  it('is quiet when the CLAUDE.md imports @AGENTS.md', () => {
    const root = useRepo('pnpm-single');
    write(root, 'AGENTS.md', REGION);
    write(root, 'CLAUDE.md', '# mine\n\n@AGENTS.md\n');

    expectQuiet(run(root, noSettings()));
  });

  it.each(['cc-plugin-agents-md@builtin', 'agents-md@builtin'])(
    'is quiet when user settings load both under %s',
    (pluginId) => {
      const root = useRepo('pnpm-single');
      write(root, 'AGENTS.md', REGION);
      write(root, 'CLAUDE.md', '# mine\n');

      expectQuiet(run(root, settingsWith(pluginId, 'claude-md-and-agents-md')));
    },
  );

  it('warns when user settings set a value that does not load both', () => {
    const root = useRepo('pnpm-single');
    write(root, 'AGENTS.md', REGION);
    write(root, 'CLAUDE.md', '# mine\n');

    const r = run(
      root,
      settingsWith('cc-plugin-agents-md@builtin', 'claude-md'),
    );

    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.level).toBe('WARN');
    expect(r.findings[0]?.msg).toContain('CLAUDE.md');
  });

  it('is silent when AGENTS.md has no houserules block', () => {
    const root = useRepo('pnpm-single');
    write(root, 'AGENTS.md', '# Repo\n\nmine\n');
    write(root, 'CLAUDE.md', '# mine\n');

    const r = run(root, noSettings());

    expect(r.findings).toHaveLength(0);
  });
});
