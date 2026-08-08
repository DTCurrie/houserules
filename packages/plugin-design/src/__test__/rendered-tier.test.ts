import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
} from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { runScript } from '#test/run';
import {
  discoverChrome,
  launchSession,
} from '../../payload/scripts/lib/cdp-session.mts';
import {
  backgroundAlpha,
  checkRenderedPage,
} from '../../payload/scripts/lib/rendered-checks.mts';

import type { RenderSession } from '../../payload/scripts/lib/cdp-session.mts';

const PLUGIN_DESIGN = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_DESIGN, alias: 'design' }];

function stubSession(evaluations: unknown[]): RenderSession {
  let call = 0;
  return {
    async navigate() {
      return { ok: true, value: undefined };
    },
    async evaluate<TValue>() {
      const value = evaluations[call] as TValue;
      call += 1;
      return { ok: true, value };
    },
    async screenshot() {
      return { ok: true, value: Buffer.from([]) };
    },
    async close() {},
  };
}

function noFindingsEvaluation(): { results: never[]; truncated: boolean } {
  return { results: [], truncated: false };
}

function installed(): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'design/design',
    plugins: PLUGINS,
  });
}

function design(root: string, ...args: string[]) {
  return runScript(root, '.claude/scripts/design.mjs', { args });
}

function writeTempHtml(html: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'design-rendered-'));
  const file = join(dir, 'fixture.html');
  writeFileSync(file, html);
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return file;
}

describe('design.mjs render', () => {
  it('prints usage and exits non-zero with no target', () => {
    const root = installed();

    const result = design(root, 'render');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('design.mjs render <target>');
  });

  it('exits non-zero fast when the target file is missing', () => {
    const root = installed();
    const startedAt = Date.now();

    const result = design(root, 'render', './does-not-exist.html');
    const elapsedMs = Date.now() - startedAt;

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/No such file: .*does-not-exist\.html\n/);
    expect(elapsedMs).toBeLessThan(5000);
  });

  it('installs the cdp-session and rendered-checks libs the render command needs', () => {
    const root = installed();

    expect(existsSync(join(root, '.claude/scripts/lib/cdp-session.mjs'))).toBe(
      true,
    );
    expect(
      existsSync(join(root, '.claude/scripts/lib/rendered-checks.mjs')),
    ).toBe(true);
  });

  describe.skipIf(!discoverChrome())('against a live rendered page', () => {
    let session: RenderSession;

    beforeAll(async () => {
      const launched = await launchSession();
      if (!launched.ok) throw new Error(launched.error);
      session = launched.value;
    });

    afterAll(async () => {
      await session.close();
    });

    it('reports composited contrast against the nearest opaque ancestor, not the page body', async () => {
      const fixture = writeTempHtml(
        [
          '<!doctype html>',
          '<html>',
          '  <body style="background:#f9fafb; margin:0; padding:2rem;">',
          '    <section class="card" style="background:#ffffff; padding:1rem;">',
          '      <p id="muted-text" style="color:#adb5bd;">Quietly informative helper text.</p>',
          '    </section>',
          '  </body>',
          '</html>',
        ].join('\n'),
      );

      const navigated = await session.navigate(pathToFileURL(fixture).href);
      expect(navigated.ok).toBe(true);
      const result = await checkRenderedPage(session, {});

      const contrastFinding = result.findings.find(
        (finding) => finding.selector === 'p#muted-text',
      );
      expect(contrastFinding?.message).toBe(
        'rgb(173, 181, 189) on effective background rgb(255, 255, 255) is 2.07:1, under the 4.5:1 minimum.',
      );
    });

    it('produces zero findings for a page styled entirely by browser defaults', async () => {
      const fixture = writeTempHtml(`<!DOCTYPE html>
<html>
  <head>
    <title>Clean</title>
  </head>
  <body>
    <h1>Plain heading</h1>
    <p>Ordinary paragraph text with default browser styling.</p>
  </body>
</html>
`);

      const navigated = await session.navigate(pathToFileURL(fixture).href);
      expect(navigated.ok).toBe(true);
      const result = await checkRenderedPage(session, {});

      expect(result.findings).toEqual([]);
    });
  });
});

describe('backgroundAlpha', () => {
  it.each([
    {
      name: 'a plain rgb() with no alpha argument',
      value: 'rgb(255, 255, 255)',
      alpha: 1,
    },
    {
      name: 'a legacy rgba() with a zero alpha',
      value: 'rgba(0, 0, 0, 0)',
      alpha: 0,
    },
    { name: 'the transparent keyword', value: 'transparent', alpha: 0 },
    {
      name: 'a modern rgb() with a slash alpha',
      value: 'rgb(0 0 0 / 0)',
      alpha: 0,
    },
    {
      name: 'an oklch() with no alpha argument',
      value: 'oklch(0.9 0.05 150)',
      alpha: 1,
    },
    {
      name: 'an oklch() with a slash alpha',
      value: 'oklch(0.9 0.05 150 / 0.5)',
      alpha: 0.5,
    },
  ])('reads $alpha for $name', ({ value, alpha }) => {
    expect(backgroundAlpha(value)).toBe(alpha);
  });
});

describe('checkRenderedPage, oklch contrast', () => {
  it.each([
    {
      name: 'oklch foreground on an oklch background',
      color: 'oklch(0.55 0.2 265)',
      background: 'oklch(0.9 0.05 150)',
      ratio: '3.83',
    },
    {
      name: 'a percentage-lightness oklch foreground on a hex background',
      color: 'oklch(63.7% 0.237 25.331)',
      background: '#7a1116',
      ratio: '2.87',
    },
    {
      name: 'a hex foreground on an oklch background, the reverse direction',
      color: '#dedede',
      background: 'oklch(0.9 0.05 150)',
      ratio: '1.02',
    },
  ])('computes $ratio:1 for $name', async ({ color, background, ratio }) => {
    const session = stubSession([
      {
        results: [{ selector: 'p#label', color, background }],
        truncated: false,
      },
      noFindingsEvaluation(),
      noFindingsEvaluation(),
    ]);

    const result = await checkRenderedPage(session, {});

    expect(
      result.findings.find((finding) => finding.selector === 'p#label')
        ?.message,
    ).toBe(
      `${color} on effective background ${background} is ${ratio}:1, under the 4.5:1 minimum.`,
    );
  });
});

describe('checkRenderedPage, computed color drift against an oklch token', () => {
  it('reports no finding when the computed color converts to the same sRGB as an oklch token', async () => {
    const session = stubSession([
      noFindingsEvaluation(),
      noFindingsEvaluation(),
      {
        results: [{ selector: 'button.cta', color: 'rgb(54, 101, 228)' }],
        truncated: false,
      },
    ]);
    const tokens = {
      color: {
        brand: {
          primary: {
            $value: { colorSpace: 'oklch', components: [0.55, 0.2, 265] },
          },
        },
      },
    };

    const result = await checkRenderedPage(session, tokens);

    expect(result.findings).toEqual([]);
  });

  it('reports a new-value finding when the computed color matches no oklch token', async () => {
    const session = stubSession([
      noFindingsEvaluation(),
      noFindingsEvaluation(),
      {
        results: [{ selector: 'button.cta', color: 'rgb(10, 10, 10)' }],
        truncated: false,
      },
    ]);
    const tokens = {
      color: {
        brand: {
          primary: {
            $value: { colorSpace: 'oklch', components: [0.55, 0.2, 265] },
          },
        },
      },
    };

    const result = await checkRenderedPage(session, tokens);

    expect(
      result.findings.find((finding) => finding.selector === 'button.cta')
        ?.message,
    ).toBe(
      'computed color rgb(10, 10, 10) matches no token. This is a new value and needs a design decision before it joins the token set.',
    );
  });
});
