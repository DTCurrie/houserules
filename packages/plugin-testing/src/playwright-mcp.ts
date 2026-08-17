import type { Action, ModuleDef, PluginApi } from '@houserules/api';

/**
 * Ships the Playwright MCP server config (stdio and VS Code) as kit-owned files under
 * `.claude/mcp/`, with the test-assertion capability turned on via `--caps=testing`.
 *
 * `defaultEnabled(): false`, since installing the config still leaves the server unconfigured
 * until wired into `.mcp.json` or an editor's own MCP config, and houserules never writes
 * `.mcp.json` for the user.
 *
 * No `options` block. `--caps=testing` is baked into the shipped args, since anyone enabling an
 * MCP module inside the testing plugin wants the assertion tools. No `check()` either: the
 * server runs from `npx` and needs nothing installed locally, so a doctor check here could never
 * fail in a way that means anything.
 */
export function playwrightMcpModule(api: PluginApi): ModuleDef {
  const id = 'playwright-mcp';
  return {
    id,
    title: 'Playwright MCP server config (.claude/mcp/)',
    group: 'optional',
    hint(): string {
      return 'stdio and VS Code configs for the Playwright MCP server, with test-assertion tools enabled';
    },
    defaultEnabled(): boolean {
      return false;
    },
    plan(): Action[] {
      return [
        api.payload.mcp(
          id,
          'playwright',
          'stdio',
          'Playwright MCP server config, stdio transport',
        ),
        api.payload.mcp(
          id,
          'playwright',
          'vscode',
          'Playwright MCP server config for VS Code',
        ),
        {
          kind: 'advise',
          text: "Playwright MCP configs installed under .claude/mcp/: playwright.stdio.json and playwright.vscode.json. Neither is wired in yet, since houserules never writes .mcp.json. Copy the `mcpServers` block from playwright.stdio.json into this repo's own .mcp.json, or for VS Code copy playwright.vscode.json into its own MCP config. The default Playwright MCP tool surface is 24 tool definitions paid on every turn, and the shipped `--caps=testing` flag adds 5 more for a total of 29. Other capabilities are opt-in and cost more: devtools 11, storage 17, vision 6, network 4, pdf 1, config 1. Add one to the copied `args` array if you need it. `--browser firefox`, `--browser webkit`, or `--browser msedge` is a one-word edit for cross-browser work, in place of the default Chromium. `--headless` is in the shipped args, and dropping it is how you watch the browser work. `--isolated` is in them because concurrent clients sharing one persistent browser profile conflict. The version is pinned to 0.0.79 because the package is pre-1.0, so `@latest` could change the tool surface and make these counts wrong. Bump the pin deliberately when you want a newer version. A repo running both this module and design/chrome-devtools-mcp at its full surface pays 58 tool definitions on every turn. Pick Chrome for performance traces, Lighthouse, and heap profiling. Pick Playwright for cross-browser work and test assertions.",
          module: id,
        },
      ];
    },
  };
}
