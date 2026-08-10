import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCli } from '#test/run';

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MINIMAL_FIXTURE = join(KIT_ROOT, 'test/plugin-fixture/minimal');

function writePayloadBackedFixture(pluginDir: string): void {
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, 'package.json'),
    JSON.stringify({
      name: '@agent-kit/plugin-fixture-payload-backed',
      version: '1.0.0',
      private: true,
      main: 'index.cjs',
    }),
  );
  writeFileSync(
    join(pluginDir, 'index.cjs'),
    `const { join } = require('node:path');
module.exports = function payloadBackedPlugin() {
  return [
    {
      id: 'notes',
      title: 'Notes',
      group: 'optional',
      hint: () => 'payload-backed fixture module',
      defaultEnabled: () => true,
      plan: () => [
        {
          module: 'notes',
          kind: 'copy',
          src: join(__dirname, 'payload-dist', 'rules', 'notes.md'),
          dest: '.claude/rules/notes.md',
          reason: 'fixture rule',
        },
      ],
    },
  ];
};
`,
  );
}

function writeEscapingFixture(pluginDir: string): void {
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, 'package.json'),
    JSON.stringify({
      name: '@agent-kit/plugin-fixture-escaping',
      version: '1.0.0',
      private: true,
      main: 'index.cjs',
    }),
  );
  writeFileSync(
    join(pluginDir, 'index.cjs'),
    `const { join } = require('node:path');
module.exports = function escapingPlugin() {
  return [
    {
      id: 'notes',
      title: 'Notes',
      group: 'optional',
      hint: () => 'escaping fixture module',
      defaultEnabled: () => true,
      plan: () => [
        {
          module: 'notes',
          kind: 'copy',
          src: join(__dirname, '..', 'outside.md'),
          dest: '.claude/rules/notes.md',
          reason: 'fixture rule',
        },
      ],
    },
  ];
};
`,
  );
}

describe('probe, given a plugin whose action src escapes the plugin package', () => {
  let pluginDir: string;
  let escapingSrc: string;

  beforeEach(() => {
    const workDir = mkdtempSync(join(tmpdir(), 'agent-kit-probe-escape-'));
    pluginDir = join(workDir, 'plugin');
    writeEscapingFixture(pluginDir);
    escapingSrc = join(workDir, 'outside.md');
  });

  afterEach(() => {
    rmSync(dirname(pluginDir), { recursive: true, force: true });
  });

  it('exits 1', () => {
    expect(runCli(['probe', pluginDir]).status).toBe(1);
  });

  it('names the escaping src on stderr', () => {
    const stderr = runCli(['probe', pluginDir]).stderr;

    expect(stderr).toContain(`!! src escapes the plugin package: `);
    expect(stderr).toContain(basename(escapingSrc));
  });
});

describe('probe, given a package that loads', () => {
  let pluginDir: string;

  beforeEach(() => {
    const workDir = mkdtempSync(join(tmpdir(), 'agent-kit-probe-'));
    pluginDir = join(workDir, 'plugin');
    cpSync(MINIMAL_FIXTURE, pluginDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dirname(pluginDir), { recursive: true, force: true });
  });

  it('exits 0', () => {
    expect(runCli(['probe', pluginDir]).status).toBe(0);
  });

  it('lists the module it contributes, namespaced under the default alias', () => {
    expect(runCli(['probe', pluginDir]).stdout).toContain(
      'module probe/minimal',
    );
  });

  it('lists the module under a custom alias', () => {
    const result = runCli(['probe', pluginDir, '--alias', 'mine']);

    expect(result.stdout).toContain('module mine/minimal');
  });
});

describe('probe, given a plugin whose payload-dist was never built', () => {
  let pluginDir: string;
  let missingSrc: string;

  beforeEach(() => {
    const workDir = mkdtempSync(join(tmpdir(), 'agent-kit-probe-unbuilt-'));
    pluginDir = join(workDir, 'plugin');
    writePayloadBackedFixture(pluginDir);
    missingSrc = join(pluginDir, 'payload-dist', 'rules', 'notes.md');
  });

  afterEach(() => {
    rmSync(dirname(pluginDir), { recursive: true, force: true });
  });

  it('exits 1', () => {
    expect(runCli(['probe', pluginDir]).status).toBe(1);
  });

  it('names the missing payload path on stderr', () => {
    expect(runCli(['probe', pluginDir]).stderr).toContain(missingSrc);
  });
});

describe('probe, given a path that is not a plugin package', () => {
  let notAPlugin: string;

  beforeEach(() => {
    notAPlugin = mkdtempSync(join(tmpdir(), 'agent-kit-probe-not-a-plugin-'));
  });

  afterEach(() => {
    rmSync(notAPlugin, { recursive: true, force: true });
  });

  it('exits 1', () => {
    expect(runCli(['probe', notAPlugin]).status).toBe(1);
  });

  it("reports the resolver's own message on stderr", () => {
    expect(runCli(['probe', notAPlugin]).stderr).toContain(
      'has no package.json',
    );
  });
});
