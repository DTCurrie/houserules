import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { useInstalledRepo } from '#test/repo';
import { runCli } from '#test/run';
import { manifestOf } from '#test/installed-tree';

describe('persona-auditor', () => {
  const reviewerTemplate =
    '.claude/kit-templates/agents/reviewer.agent.md.template';
  const personaAuditorTemplate =
    '.claude/kit-templates/agents/persona-auditor.agent.md.template';

  it('stages the reviewer template but not persona-auditor by default', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    expect(existsSync(join(root, reviewerTemplate))).toBeTruthy();
    expect(existsSync(join(root, personaAuditorTemplate))).toBe(false);
  });

  describe('when enabled', () => {
    let root: string;
    let templateText: string;

    beforeEach(() => {
      root = useInstalledRepo('pnpm-monorepo', { modules: 'persona-auditor' });
      templateText = readFileSync(join(root, personaAuditorTemplate), 'utf8');
    });

    it('stages the persona-auditor template', () => {
      expect(templateText.length).toBeGreaterThan(0);
    });

    it('documents the anti-anchoring discipline', () => {
      expect(templateText).toMatch(/DO NOT ANCHOR|anti-anchor/i);
      expect(templateText).toMatch(/blindRanking/);
    });

    it('specifies a haiku model', () => {
      expect(templateText).toMatch(/model: haiku/);
    });

    it('records the module in the manifest', () => {
      const manifest = manifestOf(root);
      expect(manifest.modules.includes('persona-auditor')).toBeTruthy();
    });

    it('passes doctor', () => {
      expect(runCli(['doctor', root]).status).toBe(0);
    });
  });
});
