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
import { checkRenderedPage } from '../../payload/scripts/lib/rendered-checks.mts';

import type { RenderSession } from '../../payload/scripts/lib/cdp-session.mts';

const PLUGIN_DESIGN = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_DESIGN, alias: 'design' }];

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
