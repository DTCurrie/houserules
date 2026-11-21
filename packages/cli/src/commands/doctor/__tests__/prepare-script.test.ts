import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Flags } from '../../../cli-contract.js';
import { checkPrepareScript } from '../prepare-script.js';

const WITH_DEPENDENCY =
  '{\n  "devDependencies": {\n    "@houserules/cli": "1.0.0"\n  }\n}\n';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'doctor-prepare-'));
});

function writePackage(text: string): void {
  writeFileSync(join(root, 'package.json'), text);
}

function flags(fix: boolean): Flags {
  return { fix } as Flags;
}

describe('checkPrepareScript', () => {
  it('reports nothing without a package.json', () => {
    expect(checkPrepareScript(root, flags(false)).findings).toEqual([]);
  });

  it('reports nothing when the cli is not a dependency', () => {
    writePackage('{}\n');

    expect(checkPrepareScript(root, flags(false)).findings).toEqual([]);
  });

  it('reports nothing when prepare is already wired', () => {
    writePackage(
      '{\n  "scripts": {\n    "prepare": "houserules update --sync"\n  },\n  "devDependencies": {\n    "@houserules/cli": "1.0.0"\n  }\n}\n',
    );

    expect(checkPrepareScript(root, flags(false)).findings).toEqual([]);
  });

  it('warns once, naming the script and --fix, when prepare is missing', () => {
    writePackage(WITH_DEPENDENCY);

    const { findings } = checkPrepareScript(root, flags(false));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.level).toBe('WARN');
    expect(findings[0]?.msg).toContain('houserules update --sync');
    expect(findings[0]?.msg).toContain('doctor --fix');
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(
      WITH_DEPENDENCY,
    );
  });

  it('warns when an existing prepare lacks the command', () => {
    writePackage(
      '{\n  "scripts": {\n    "prepare": "husky"\n  },\n  "devDependencies": {\n    "@houserules/cli": "1.0.0"\n  }\n}\n',
    );

    expect(checkPrepareScript(root, flags(false)).findings).toHaveLength(1);
  });

  it('warns that an unparseable file could not be checked', () => {
    writePackage('{ nope');

    const { findings } = checkPrepareScript(root, flags(true));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.msg).toContain('does not parse');
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe('{ nope');
  });

  it('restores the script under --fix and reports clean', () => {
    writePackage(WITH_DEPENDENCY);

    const { findings } = checkPrepareScript(root, flags(true));

    expect(findings).toEqual([]);
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(
      '{\n  "devDependencies": {\n    "@houserules/cli": "1.0.0"\n  },\n  "scripts": {\n    "prepare": "houserules update --sync"\n  }\n}\n',
    );
  });
});
