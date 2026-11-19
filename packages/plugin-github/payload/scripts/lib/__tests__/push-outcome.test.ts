import * as fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PUSH_OUTCOME_PREFIX,
  formatPushOutcome,
  recordPushOutcomeOnExit,
} from '../push-outcome.mjs';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  writeSync: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('formatPushOutcome', () => {
  it('round-trips through JSON.parse after the prefix', () => {
    const outcome = {
      at: '2026-11-18T10:00:00.000Z',
      exitCode: 1,
      error: 'boom',
      pending: { backlog: 1, decisions: 2 },
    };

    const line = formatPushOutcome(outcome);

    expect(line.startsWith(PUSH_OUTCOME_PREFIX)).toBe(true);
    expect(JSON.parse(line.slice(PUSH_OUTCOME_PREFIX.length))).toEqual(outcome);
  });
});

describe('recordPushOutcomeOnExit', () => {
  it('keeps the first console.error line and writes the outcome on exit', () => {
    const originalError = console.error;
    const handlers: Array<(code: number) => void> = [];
    vi.spyOn(process, 'on').mockImplementation(((
      event: string,
      handler: (code: number) => void,
    ) => {
      if (event === 'exit') handlers.push(handler);
      return process;
    }) as never);
    const written: string[] = [];
    vi.mocked(fs.writeSync).mockImplementation(((_fd: number, text: string) => {
      written.push(text);
      return text.length;
    }) as never);
    const sink = vi.fn();
    console.error = sink;

    try {
      recordPushOutcomeOnExit(
        () => ({ backlog: 1, decisions: 0 }),
        () => 'NOW',
      );
      console.error('first line\nsecond line');
      console.error('later');
      handlers[0]?.(1);
    } finally {
      console.error = originalError;
    }

    expect(sink).toHaveBeenCalledTimes(2);
    expect(written).toHaveLength(1);
    expect(
      JSON.parse((written[0] ?? '').slice(PUSH_OUTCOME_PREFIX.length)),
    ).toEqual({
      at: 'NOW',
      exitCode: 1,
      error: 'first line',
      pending: { backlog: 1, decisions: 0 },
    });
  });
});
