import { afterEach, describe, expect, it, vi } from 'vitest';

const accessSyncMock = vi.fn<(path: string, mode?: number) => void>();

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    accessSync: (path: string, mode?: number) => accessSyncMock(path, mode),
  };
});

const { checkChromeAvailable } = await import('../chrome-check.js');
const { accessSync: realAccessSync } =
  await vi.importActual<typeof import('node:fs')>('node:fs');

function withChromePath(value: string | undefined): void {
  if (value === undefined) delete process.env.CHROME_PATH;
  else process.env.CHROME_PATH = value;
}

describe('checkChromeAvailable', () => {
  const originalChromePath = process.env.CHROME_PATH;

  afterEach(() => {
    withChromePath(originalChromePath);
    accessSyncMock.mockReset();
  });

  it('reports a readout and no findings when CHROME_PATH points at a real executable', () => {
    withChromePath(process.execPath);
    accessSyncMock.mockImplementation(realAccessSync);

    const result = checkChromeAvailable();

    expect(result.findings).toEqual([]);
    expect(result.readouts).toEqual([
      `design: rendered checks will use CHROME_PATH (${process.execPath})`,
    ]);
  });

  it('falls through to the candidate list when CHROME_PATH does not exist', () => {
    withChromePath('/definitely/not/a/real/chrome-binary');
    accessSyncMock.mockImplementation((path) => {
      if (path !== '/Applications/Chromium.app/Contents/MacOS/Chromium') {
        throw new Error('ENOENT');
      }
    });

    const result = checkChromeAvailable();

    expect(result.findings).toEqual([]);
    expect(result.readouts).toEqual([
      'design: rendered checks will use /Applications/Chromium.app/Contents/MacOS/Chromium',
    ]);
  });

  it('reports one WARN finding, never ERROR, when no Chrome is discoverable anywhere', () => {
    withChromePath(undefined);
    accessSyncMock.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const result = checkChromeAvailable();

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.level).toBe('WARN');
    expect(result.findings[0]?.msg).toContain('no Chrome or Chromium found');
  });
});
