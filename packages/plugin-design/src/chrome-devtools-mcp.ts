import { checkChromeAvailable } from './chrome-check.js';

import type {
  Action,
  CheckResult,
  ModuleDef,
  PluginApi,
} from '@houserules/api';

/**
 * What the installed config actually costs, measured against `chrome-devtools-mcp@1.7.0` with
 * the shipped args by handshaking with the server and reading `tools/list`.
 *
 * The package DEFINES 52 tools and registers 29 of them. The other 23 sit behind flags the
 * shipped args do not pass, so counting the source is how the earlier "50" got here. Any bump
 * to the pinned version has to re-measure rather than re-count.
 */
const FULL_TOOL_COUNT = 29;
const SLIM_TOOL_COUNT = 3;

/** `playwright-mcp`'s own count with its shipped `--caps=testing`, measured the same way. */
const PLAYWRIGHT_TOOL_COUNT = 29;

/**
 * The wiring instructions, worded for the variant this run actually installed.
 *
 * One text covering both variants would have to hedge every count, and the count is the whole
 * reason the option exists.
 */
function adviseText(slim: boolean): string {
  const installed = slim
    ? `The slim variant is installed: ${SLIM_TOOL_COUNT} tools, navigate, evaluate, and screenshot, about 1KB of schema paid on every turn. It has no accessibility snapshot, so there are no element uids and no click, fill, or press_key. Drive the page by passing JavaScript to evaluate. The full variant is ${FULL_TOOL_COUNT} tools and about 23KB.`
    : `The full variant is installed: ${FULL_TOOL_COUNT} tools, about 23KB of schema paid on every turn whether you use them or not. The slim variant is ${SLIM_TOOL_COUNT} tools and about 1KB. Upstream docs list more tools than ${FULL_TOOL_COUNT} because the package defines 52 and leaves 23 behind flags the shipped args do not pass, such as --memoryDebugging and --categoryExtensions.`;
  return `Chrome DevTools MCP config installed under .claude/mcp/: chrome-devtools.stdio.json and chrome-devtools.vscode.json. Neither is wired in yet, since houserules never writes .mcp.json. Copy the \`mcpServers\` block from chrome-devtools.stdio.json into this repo's own .mcp.json, or for VS Code copy chrome-devtools.vscode.json into its own MCP config. ${installed} Run \`/chrome-devtools-mode\` to switch a wired-in config between the two. Re-running houserules only rewrites the reference copy under .claude/mcp/, which is not the config your client reads. \`--no-usage-statistics\` is in the shipped args because upstream defaults telemetry on. \`--headless\` is in them too, so the browser runs with no window. Drop it yourself to watch the browser work. The version is pinned to chrome-devtools-mcp@1.7.0 so the tool counts above stay true. Bumping it is a deliberate edit to this payload file, not a no-op. A repo running the full variant and testing/playwright-mcp pays ${FULL_TOOL_COUNT + PLAYWRIGHT_TOOL_COUNT} tool definitions on every turn. Reach for Chrome DevTools for performance traces, Lighthouse audits, and heap snapshots. Reach for Playwright for cross-browser work and test assertions. This module does not replace \`node .claude/scripts/design.mjs render\`, which stays the deterministic tier for design checks.`;
}

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
      return `stdio and VS Code configs for the Chrome DevTools MCP server, ${FULL_TOOL_COUNT} tools by default with a slim ${SLIM_TOOL_COUNT}-tool option`;
    },
    defaultEnabled(): boolean {
      return false;
    },
    options: {
      prompt: `Install the slim (${SLIM_TOOL_COUNT}-tool) variant instead of the full surface?`,
      choices: [
        {
          value: 'slim',
          label: `Slim (${SLIM_TOOL_COUNT} tools instead of ${FULL_TOOL_COUNT})`,
          hint: 'navigate, evaluate, screenshot. No snapshot, so no click or fill',
        },
      ],
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
        api.payload.skill(
          id,
          'chrome-devtools-mode',
          'switch the wired-in Chrome DevTools MCP server between the full and slim tool surfaces',
        ),
        {
          kind: 'advise',
          text: adviseText(slim),
          module: id,
        },
      ];
    },
    check(): CheckResult {
      return checkChromeAvailable();
    },
  };
}
