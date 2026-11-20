import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(
  new URL('../health-kit/gather/extract-exports.mjs', import.meta.url),
);

function extract(documentLines, machine = 'local') {
  const dir = mkdtempSync(join(tmpdir(), 'extract-exports-'));
  const doc = join(dir, 'doc.md');
  const outDir = join(dir, 'nested', 'out');
  writeFileSync(doc, documentLines.join('\n'));
  const result = spawnSync(process.execPath, [SCRIPT, doc, machine, outDir], {
    encoding: 'utf8',
  });
  return { ...result, outDir };
}

describe('extract-exports', () => {
  it('writes one pretty-printed file per json block, named machine--repo', () => {
    const result = extract([
      '# houserules usage report: 2026-11-19',
      '',
      '```json',
      '{"not": "an export"}',
      '```',
      '',
      '## Exports',
      '',
      '<details>',
      '<summary>radium-sunrise.json</summary>',
      '',
      '```json',
      '{',
      '  "meta": { "label": "radium-sunrise", "cliVersion": "0.15.0" }',
      '}',
      '```',
      '',
      '</details>',
      '<details>',
      '<summary>houserules.json</summary>',
      '',
      '```json',
      '{"meta":{"label":"houserules","cliVersion":"0.15.0"}}',
      '```',
      '</details>',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      'local--radium-sunrise.json\nlocal--houserules.json\n2 exports\n',
    );
    assert.deepEqual(readdirSync(result.outDir).sort(), [
      'local--houserules.json',
      'local--radium-sunrise.json',
    ]);
    assert.equal(
      readFileSync(join(result.outDir, 'local--houserules.json'), 'utf8'),
      '{\n  "meta": {\n    "label": "houserules",\n    "cliVersion": "0.15.0"\n  }\n}\n',
    );
  });

  it('exits 1 when the document has no Exports section', () => {
    const result = extract(['# houserules usage report: 2026-11-19']);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /no "## Exports" section/);
  });

  it('exits 1 naming the repo when a block is not valid JSON', () => {
    const result = extract([
      '## Exports',
      '<summary>widgets.json</summary>',
      '```json',
      '{ "meta": ',
      '```',
    ]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /extract-exports: widgets: /);
  });

  it('exits 1 when a json block has no summary before it', () => {
    const result = extract(['## Exports', '```json', '{}', '```']);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /json fence at line 4 has no summary/);
  });

  it('exits 2 with a usage line when an argument is missing', () => {
    const result = spawnSync(process.execPath, [SCRIPT, 'doc.md'], {
      encoding: 'utf8',
    });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage: node extract-exports.mjs/);
  });
});
