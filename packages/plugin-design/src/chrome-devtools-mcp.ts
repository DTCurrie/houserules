import { checkChromeAvailable } from './chrome-check.js';

import type {
  Action,
  CheckResult,
  ModuleDef,
  PluginApi,
} from '@houserules/api';

const FULL_ADVISE_TEXT =
  "Chrome DevTools MCP config installed under .claude/mcp/: chrome-devtools.stdio.json and chrome-devtools.vscode.json. Neither is wired in yet, since houserules never writes .mcp.json. Copy the `mcpServers` block from chrome-devtools.stdio.json into this repo's own .mcp.json, or for VS Code copy chrome-devtools.vscode.json into its own MCP config. The default surface is 50 tool definitions paid on every turn. Install with the `slim` option for the 3-tool variant instead. `--no-usage-statistics` is in the shipped args because upstream defaults telemetry on. `--headless` is in them too, so the browser runs with no window. Drop it yourself to watch the browser work. The version is pinned to chrome-devtools-mcp@1.7.0 so the tool counts above stay true. Bumping it is a deliberate edit to this payload file, not a no-op. A repo running both this module and testing/playwright-mcp pays 74 tool definitions on every turn. Reach for Chrome DevTools for performance traces, Lighthouse audits, and heap snapshots. Reach for Playwright for cross-browser work and test assertions. This module does not replace `node .claude/scripts/design.mjs render`, which stays the deterministic tier for design checks.";

/**
 * Ships the Chrome DevTools MCP server config (stdio and VS Code) as kit-owned files under
 * `.claude/mcp/`, mirroring `svelte-mcp` in `plugin-svelte`. A module of its own, not an
 * option of `designModule`, since an MCP config needs nothing from the design rule or the
 * token set, and a repo can want the browser without wanting a design system.
 *
 * `defaultEnabled(): false`, since installing the files still leaves the server unconfigured
 * until wired into `.mcp.json` or an editor's own MCP config, and houserules never writes
 * `.mcp.json` for the user.
 */
export function chromeDevtoolsMcpModule(api: PluginApi): ModuleDef {
  const id = 'chrome-devtools-mcp';
  return {
    id,
    title: 'Chrome DevTools MCP server config (.claude/mcp/)',
    group: 'optional',
    hint(): string {
      return 'stdio and VS Code configs for the Chrome DevTools MCP server, full surface by default with a slim 3-tool option';
    },
    defaultEnabled(): boolean {
      return false;
    },
    options: {
      prompt: 'Install the slim (3-tool) variant instead of the full surface?',
      choices: [{ value: 'slim', label: 'Slim (3 tools instead of 50)' }],
      defaults: [],
    },
    plan(_ctx, answers): Action[] {
      const chosen = answers.moduleOptions[`${api.alias}/${id}`] ?? [];
      const slim = chosen.includes('slim');
      // The slim pair installs to the same dest as the full pair, since only one variant is
      // planned per run. `api.payload.mcp()` derives its dest from the server name, which
      // would collide on one dest for two different sources, so the slim pair uses the
      // `file()` escape hatch with an explicit dest instead.
      const stdio = slim
        ? api.payload.file({
            module: id,
            srcRel: 'mcp/chrome-devtools-slim.stdio.json',
            dest: '.claude/mcp/chrome-devtools.stdio.json',
            reason:
              'Chrome DevTools MCP server config, stdio transport, slim tool surface',
          })
        : api.payload.mcp(
            id,
            'chrome-devtools',
            'stdio',
            'Chrome DevTools MCP server config, stdio transport',
          );
      const vscode = slim
        ? api.payload.file({
            module: id,
            srcRel: 'mcp/chrome-devtools-slim.vscode.json',
            dest: '.claude/mcp/chrome-devtools.vscode.json',
            reason:
              'Chrome DevTools MCP server config for VS Code, slim tool surface',
          })
        : api.payload.mcp(
            id,
            'chrome-devtools',
            'vscode',
            'Chrome DevTools MCP server config for VS Code',
          );
      return [
        stdio,
        vscode,
        {
          kind: 'advise',
          text: FULL_ADVISE_TEXT,
          module: id,
        },
      ];
    },
    check(): CheckResult {
      return checkChromeAvailable();
    },
  };
}
