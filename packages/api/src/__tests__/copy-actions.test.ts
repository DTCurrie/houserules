import { describe, expect, it } from 'vitest';

import { createPayloadBuilders } from '../copy-actions.js';

const builders = createPayloadBuilders('/payload');

describe('createPayloadBuilders', () => {
  describe('mcp', () => {
    it('namespaces the destination by server name so two plugins cannot collide', () => {
      const svelte = builders.mcp('svelte-mcp', 'svelte', 'stdio', 'reason');
      const playwright = builders.mcp(
        'playwright-mcp',
        'playwright',
        'stdio',
        'reason',
      );

      expect(svelte.dest).toBe('.claude/mcp/svelte.stdio.json');
      expect(playwright.dest).toBe('.claude/mcp/playwright.stdio.json');
      expect(svelte.dest).not.toBe(playwright.dest);
    });

    it('resolves the source inside the payload root it was bound to', () => {
      const action = builders.mcp(
        'chrome-mcp',
        'chrome-devtools',
        'vscode',
        'reason',
      );

      expect(action.src).toBe('/payload/mcp/chrome-devtools.vscode.json');
    });

    it('emits one destination per transport for the same server', () => {
      const dests = (['stdio', 'http', 'vscode'] as const).map(
        (transport) =>
          builders.mcp('svelte-mcp', 'svelte', transport, 'reason').dest,
      );

      expect(dests).toEqual([
        '.claude/mcp/svelte.stdio.json',
        '.claude/mcp/svelte.http.json',
        '.claude/mcp/svelte.vscode.json',
      ]);
    });

    it('is a kit-owned copy, so update refreshes it', () => {
      const action = builders.mcp(
        'svelte-mcp',
        'svelte',
        'stdio',
        'server config',
      );

      expect(action.kind).toBe('copy');
      expect(action.module).toBe('svelte-mcp');
      expect(action.reason).toBe('server config');
    });
  });
});
