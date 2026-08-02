/**
 * The CLAUDE.md managed-region contract, asserted end-to-end against a real install.
 *
 * The invariant everything here protects: bytes outside the markers are never modified.
 * Assertions compare exact substrings and full-file byte equality rather than
 * `toContain`, because a passing `toContain` would not catch a subtly reformatted prefix
 * or suffix.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import { makeFixture, runCli } from './fixtures.js';

const START = '<!-- claude-kit:claude-md start -->';
const END = '<!-- claude-kit:claude-md end -->';

function claudeMdPath(root: string): string {
  return join(root, 'CLAUDE.md');
}

function readClaudeMd(root: string): string {
  return readFileSync(claudeMdPath(root), 'utf8');
}

test('CM1: init inserts a managed block into an existing CLAUDE.md, original prose intact', () => {
  const root = makeFixture('npm-single');
  try {
    // fixture ships: '# single-app\n\nPre-existing user CLAUDE.md. The kit must never edit this.\n'
    const before = readClaudeMd(root);
    const heading = '# single-app\n\n';
    const prose =
      'Pre-existing user CLAUDE.md — the kit must never edit this.\n';
    expect(before).toBe(`${heading}${prose}`);

    expect(runCli(['init', '--yes', root]).status).toBe(0);

    const after = readClaudeMd(root);
    // anchor: after-h1 splices the block right after the H1. Both original
    // fragments must survive verbatim, unreformatted, on either side of it.
    expect(after.startsWith(heading)).toBe(true);
    expect(after.endsWith(prose)).toBe(true);
    expect(after).toContain(START);
    expect(after).toContain(END);
    expect(after.indexOf(START)).toBeLessThan(after.indexOf(END));
    expect(after.indexOf(END)).toBeLessThan(after.indexOf(prose));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CM2: prose added above and below the block survives an update byte-for-byte', () => {
  const root = makeFixture('npm-single');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);

    const installed = readClaudeMd(root);
    const startIdx = installed.indexOf(START);
    const endIdx = installed.indexOf(END) + END.length;
    const prefix = installed.slice(0, startIdx);
    const suffix = installed.slice(endIdx);

    const editedPrefix = `${prefix}Extra note added above the block by the user.\n`;
    const editedSuffix = `${suffix}\nExtra note added below the block by the user.\n`;
    const edited = `${editedPrefix}${installed.slice(startIdx, endIdx)}${editedSuffix}`;
    writeFileSync(claudeMdPath(root), edited);

    expect(runCli(['update', root]).status).toBe(0);

    const after = readClaudeMd(root);
    expect(after.startsWith(editedPrefix)).toBe(true);
    expect(after.endsWith(editedSuffix)).toBe(true);
    expect(after).toContain(START);
    expect(after).toContain(END);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CM3: two consecutive updates leave CLAUDE.md byte-identical', () => {
  const root = makeFixture('npm-single');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    expect(runCli(['update', root]).status).toBe(0);
    const once = readClaudeMd(root);
    expect(runCli(['update', root]).status).toBe(0);
    const twice = readClaudeMd(root);
    expect(twice).toBe(once);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CM4: claudeMd.managed: false leaves an existing CLAUDE.md completely untouched', () => {
  const root = makeFixture('npm-single');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    // Revert to a pristine CLAUDE.md with no managed block, then opt out and update.
    const pristine =
      '# single-app\n\nPre-existing user CLAUDE.md — the kit must never edit this.\n';
    writeFileSync(claudeMdPath(root), pristine);

    const configPath = join(root, '.claude/kit.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<
      string,
      unknown
    >;
    config.claudeMd = { managed: false };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    expect(runCli(['update', root]).status).toBe(0);
    expect(readClaudeMd(root)).toBe(pristine);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CM5: a fresh repo with no CLAUDE.md gets one seeded with the managed markers', () => {
  const root = makeFixture('non-js');
  try {
    expect(existsSync(claudeMdPath(root))).toBe(false);
    expect(runCli(['init', '--yes', root]).status).toBe(0);

    expect(existsSync(claudeMdPath(root))).toBe(true);
    const content = readClaudeMd(root);
    expect(content).toContain(START);
    expect(content).toContain(END);
    expect(content.indexOf(START)).toBeLessThan(content.indexOf(END));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
