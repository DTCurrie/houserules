import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const PARSER = fileURLToPath(
  new URL('../health-kit/gather/parse-usage-report.mjs', import.meta.url),
);

function projectSection(name, fenceLines) {
  return [
    `### ${name}`,
    '',
    `- **Path:** \`~/Github/${name}\``,
    '- **Kit version:** 0.4.1 (installed 2026-08-26T17:08:56.875Z)',
    '- **Report produced by CLI:** 0.15.0 (temporary install)',
    '',
    '```text',
    '',
    `=== houserules report — ~/Github/${name} ===`,
    '',
    ...fenceLines,
    '```',
    '',
  ].join('\n');
}

function document(name, fenceLines) {
  return [
    '# houserules usage report: 2026-11-19',
    '',
    '## Summary',
    '',
    '| Project | Kit version (manifest) | Installed at | Report CLI | Sessions | Turns | Modules |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    `| ${name} | 0.4.1 | 2026-08-26 | 0.15.0 (temporary install) | 0 | 0 | 31 |`,
    '',
    '## Per-project reports',
    '',
    projectSection(name, fenceLines),
  ].join('\n');
}

function run(text) {
  const dir = mkdtempSync(join(tmpdir(), 'parse-usage-'));
  const doc = join(dir, 'doc.md');
  const out = join(dir, 'out.json');
  writeFileSync(doc, text);
  const result = spawnSync(process.execPath, [PARSER, doc, out], {
    encoding: 'utf8',
  });
  return { ...result, out };
}

describe('parse-usage-report, empty projects', () => {
  for (const { label, line } of [
    {
      label: 'No .jsonl transcripts in',
      line: 'No .jsonl transcripts in ~/.claude/projects/-Users-<user>-Github-widgets.',
    },
    {
      label: 'No transcripts found (looked in',
      line: 'No transcripts found (looked in ~/.claude/projects/-Users-<user>-Github-widgets).',
    },
  ]) {
    it(`reads "${label}" as an empty render`, () => {
      const result = run(document('widgets', [line]));

      assert.equal(result.status, 0, result.stderr);
      const parsed = JSON.parse(readFileSync(result.out, 'utf8'));
      assert.equal(parsed.projects.length, 1);
      assert.equal(parsed.projects[0].name, 'widgets');
      assert.equal(parsed.projects[0].render, 'empty');
      assert.equal(parsed.projects[0].sessions.length, 0);
      assert.equal(parsed.projects[0].totals, null);
    });
  }

  it('still exits 1 naming the project when the fence has neither empty line nor a session line', () => {
    const result = run(document('widgets', ['Some other message.']));

    assert.equal(result.status, 1);
    assert.match(result.stderr, /widgets: no "N session\(s\):" line/);
  });
});
