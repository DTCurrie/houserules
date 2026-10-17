import { describe, expect, it } from 'vitest';

import { useInstalledRepo } from '#test/repo';
import { runScript } from '#test/run';

const SCRIPT = '.claude/scripts/tool-output-trim.mjs';
const CAP = 16384;
const HEAD = 12288;
const TAIL = 4096;
const ELISION_PATTERN =
  /\[houserules tool-output-trim: elided (\d+) bytes of (\d+);/;

function numberedLines(totalBytes: number): string {
  let text = '';
  for (let n = 0; text.length < totalBytes; n++) {
    text += `line ${String(n).padStart(6, '0')}\n`;
  }
  return text.slice(0, totalBytes);
}

function bashPayload(stdout: string): string {
  return JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command: 'cat big' },
    tool_response: {
      stdout,
      stderr: 'warn',
      interrupted: false,
      isImage: false,
    },
  });
}

function install(): string {
  return useInstalledRepo('pnpm-monorepo', { modules: 'tool-output-trim' });
}

function updatedOutput(stdout: string): Record<string, unknown> {
  return (JSON.parse(stdout) as { hookSpecificOutput: Record<string, unknown> })
    .hookSpecificOutput['updatedToolOutput'] as Record<string, unknown>;
}

describe('tool-output-trim script', () => {
  it('returns the full Bash tool_response with only stdout shortened to head plus tail', () => {
    const root = install();
    const original = numberedLines(40000);

    const result = runScript(root, SCRIPT, { input: bashPayload(original) });

    const parsed = JSON.parse(result.stdout) as {
      hookSpecificOutput: { hookEventName: string };
    };
    const updated = updatedOutput(result.stdout);
    const trimmed = updated['stdout'] as string;
    const elision = trimmed.match(ELISION_PATTERN);
    expect(result.status).toBe(0);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(Object.keys(updated).sort()).toEqual([
      'interrupted',
      'isImage',
      'stderr',
      'stdout',
    ]);
    expect(updated['stderr']).toBe('warn');
    expect(Buffer.byteLength(trimmed)).toBeLessThan(CAP + 200);
    expect(trimmed.startsWith(original.slice(0, HEAD - 100))).toBe(true);
    expect(trimmed.endsWith(original.slice(-(TAIL - 100)))).toBe(true);
    expect(Buffer.byteLength(trimmed)).toBeGreaterThan(CAP - 200);
    expect(elision, 'elision line missing').not.toBeNull();
    expect(Number(elision![2])).toBe(40000);
    expect(
      Number(elision![1]) +
        Buffer.byteLength(trimmed.replace(/\n\[houserules[^\n]*\]\n/, '')),
    ).toBe(40000);
  });

  it('writes nothing for a Bash result one byte under the cap', () => {
    const root = install();

    const result = runScript(root, SCRIPT, {
      input: bashPayload('x'.repeat(CAP - 1)),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('writes nothing for a Bash result of exactly the cap', () => {
    const root = install();

    const result = runScript(root, SCRIPT, {
      input: bashPayload('x'.repeat(CAP)),
    });

    expect(result.stdout).toBe('');
  });

  it('trims Read file.content in place and keeps file.filePath', () => {
    const root = install();
    const original = numberedLines(50000);
    const input = JSON.stringify({
      tool_name: 'Read',
      tool_input: { file_path: '/repo/big.txt' },
      tool_response: {
        type: 'text',
        file: { filePath: '/repo/big.txt', content: original, numLines: 5000 },
      },
    });

    const result = runScript(root, SCRIPT, { input });

    const updated = updatedOutput(result.stdout) as {
      type: string;
      file: { filePath: string; numLines: number; content: string };
    };
    expect(updated.type).toBe('text');
    expect(updated.file.filePath).toBe('/repo/big.txt');
    expect(updated.file.numLines).toBe(5000);
    expect(updated.file.content).toMatch(ELISION_PATTERN);
    expect(updated.file.content.startsWith(original.slice(0, HEAD - 100))).toBe(
      true,
    );
    expect(updated.file.content.endsWith(original.slice(-(TAIL - 100)))).toBe(
      true,
    );
  });

  it('cuts multibyte text on a character boundary', () => {
    const root = install();
    const original = '€'.repeat(10000);

    const result = runScript(root, SCRIPT, { input: bashPayload(original) });

    const trimmed = updatedOutput(result.stdout)['stdout'] as string;
    expect(trimmed).not.toContain('�');
    expect(Buffer.byteLength(trimmed)).toBeLessThan(CAP + 200);
  });

  it('writes nothing for an unknown tool name', () => {
    const root = install();
    const input = JSON.stringify({
      tool_name: 'Grep',
      tool_response: { stdout: 'x'.repeat(50000) },
    });

    const result = runScript(root, SCRIPT, { input });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('exits 0 with nothing on invalid JSON', () => {
    const root = install();

    const result = runScript(root, SCRIPT, { input: '{not json' });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });
});
