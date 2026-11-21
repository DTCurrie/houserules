import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { applyPrepareScript, planPrepareScript } from '../prepare-script.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'prepare-script-'));
});

function writePackage(text: string): void {
  writeFileSync(join(root, 'package.json'), text);
}

function readPackage(): string {
  return readFileSync(join(root, 'package.json'), 'utf8');
}

function planAndApply(): boolean {
  return applyPrepareScript(root, planPrepareScript(root));
}

describe('planPrepareScript', () => {
  it('reports absent when there is no package.json', () => {
    expect(planPrepareScript(root)).toEqual({ kind: 'absent' });
  });

  it('adds the script after existing scripts when there is no prepare', () => {
    writePackage(
      '{\n  "name": "x",\n  "scripts": {\n    "test": "vitest"\n  },\n  "devDependencies": {\n    "@houserules/cli": "^1.0.0"\n  }\n}\n',
    );

    const plan = planPrepareScript(root);

    expect(plan.kind).toBe('add');
    expect(planAndApply()).toBe(true);
    expect(readPackage()).toBe(
      '{\n  "name": "x",\n  "scripts": {\n    "test": "vitest",\n    "prepare": "houserules update --sync"\n  },\n  "devDependencies": {\n    "@houserules/cli": "^1.0.0"\n  }\n}\n',
    );
  });

  it('appends to an existing prepare in place', () => {
    writePackage(
      '{\n  "scripts": {\n    "prepare": "husky",\n    "test": "vitest"\n  },\n  "dependencies": {\n    "@houserules/cli": "1.0.0"\n  }\n}\n',
    );

    const plan = planPrepareScript(root);

    expect(plan).toMatchObject({
      kind: 'append',
      before: 'husky',
      after: 'husky && houserules update --sync',
    });
    expect(planAndApply()).toBe(true);
    expect(readPackage()).toBe(
      '{\n  "scripts": {\n    "prepare": "husky && houserules update --sync",\n    "test": "vitest"\n  },\n  "dependencies": {\n    "@houserules/cli": "1.0.0"\n  }\n}\n',
    );
  });

  it('leaves an already wired prepare untouched', () => {
    const text =
      '{\n  "scripts": {\n    "prepare": "houserules update --sync && husky"\n  },\n  "devDependencies": {\n    "@houserules/cli": "1.0.0"\n  }\n}\n';
    writePackage(text);

    expect(planPrepareScript(root)).toEqual({
      kind: 'wired',
      current: 'houserules update --sync && husky',
    });
    expect(planAndApply()).toBe(false);
    expect(readPackage()).toBe(text);
  });

  it('reports an unparseable file with the parser message and never rewrites it', () => {
    const text = '{ "scripts": ';
    writePackage(text);

    const plan = planPrepareScript(root);

    expect(plan.kind).toBe('unparseable');
    expect(plan).toHaveProperty('message', expect.stringMatching(/JSON/));
    expect(planAndApply()).toBe(false);
    expect(readPackage()).toBe(text);
  });

  it('writes nothing when @houserules/cli is not a dependency', () => {
    const text = '{\n  "scripts": {\n    "test": "vitest"\n  }\n}\n';
    writePackage(text);

    expect(planPrepareScript(root)).toEqual({ kind: 'no-dependency' });
    expect(planAndApply()).toBe(false);
    expect(readPackage()).toBe(text);
  });

  it('creates the scripts object last in the file when there is none', () => {
    writePackage(
      '{\n  "name": "x",\n  "devDependencies": {\n    "@houserules/cli": "1.0.0"\n  }\n}\n',
    );

    expect(planAndApply()).toBe(true);
    expect(readPackage()).toBe(
      '{\n  "name": "x",\n  "devDependencies": {\n    "@houserules/cli": "1.0.0"\n  },\n  "scripts": {\n    "prepare": "houserules update --sync"\n  }\n}\n',
    );
  });

  it('keeps four-space indentation', () => {
    writePackage(
      '{\n    "dependencies": {\n        "@houserules/cli": "1.0.0"\n    }\n}\n',
    );

    expect(planAndApply()).toBe(true);
    expect(readPackage()).toBe(
      '{\n    "dependencies": {\n        "@houserules/cli": "1.0.0"\n    },\n    "scripts": {\n        "prepare": "houserules update --sync"\n    }\n}\n',
    );
  });

  it('keeps tab indentation', () => {
    writePackage(
      '{\n\t"dependencies": {\n\t\t"@houserules/cli": "1.0.0"\n\t}\n}\n',
    );

    expect(planAndApply()).toBe(true);
    expect(readPackage()).toBe(
      '{\n\t"dependencies": {\n\t\t"@houserules/cli": "1.0.0"\n\t},\n\t"scripts": {\n\t\t"prepare": "houserules update --sync"\n\t}\n}\n',
    );
  });

  it('keeps a missing trailing newline missing', () => {
    writePackage(
      '{\n  "dependencies": {\n    "@houserules/cli": "1.0.0"\n  }\n}',
    );

    expect(planAndApply()).toBe(true);
    expect(readPackage()).toBe(
      '{\n  "dependencies": {\n    "@houserules/cli": "1.0.0"\n  },\n  "scripts": {\n    "prepare": "houserules update --sync"\n  }\n}',
    );
  });

  it('keeps CRLF line endings', () => {
    writePackage(
      '{\r\n  "dependencies": {\r\n    "@houserules/cli": "1.0.0"\r\n  }\r\n}\r\n',
    );

    expect(planAndApply()).toBe(true);
    expect(readPackage()).toBe(
      '{\r\n  "dependencies": {\r\n    "@houserules/cli": "1.0.0"\r\n  },\r\n  "scripts": {\r\n    "prepare": "houserules update --sync"\r\n  }\r\n}\r\n',
    );
  });
});
