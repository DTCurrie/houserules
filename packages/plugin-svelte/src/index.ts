import { definePlugin } from '@agent-kit/cli/plugin';
import type { Action, ModuleDef, PluginApi } from '@agent-kit/cli/plugin';

/**
 * Ships the path-scoped Svelte 5 rule, plus an opt-in SvelteKit guide.
 *
 * The guide is an option value of this module rather than a module of its own, because it is
 * a dangling pointer without the base rule installed alongside it: it opens by assuming
 * `svelte.md`.
 *
 * `defaults: []`: SvelteKit is not true of every Svelte repo (a component library is Svelte
 * with no router at all), so it is an explicit choice, made once the caller knows this repo
 * actually uses SvelteKit.
 */
function svelteModule(api: PluginApi): ModuleDef {
  const id = 'svelte';
  return {
    id,
    title: 'Svelte 5 rule (.claude/rules/svelte.md)',
    group: 'optional',
    hint(): string {
      return 'path-scoped rule for Svelte 5 runes and component conventions, with an opt-in SvelteKit guide';
    },
    defaultEnabled(): boolean {
      return false;
    },
    options: {
      prompt: 'Install the SvelteKit guide alongside the base rule?',
      choices: [{ value: 'sveltekit', label: 'SvelteKit' }],
      defaults: [],
    },
    plan(_ctx, answers): Action[] {
      const chosen = answers.moduleOptions[`${api.alias}/${id}`] ?? [];
      const guideActions: Action[] = chosen.includes('sveltekit')
        ? [
            api.payload.rule(
              id,
              'sveltekit',
              'SvelteKit routing, load functions, and form actions, opt-in via svelte options',
            ),
          ]
        : [];
      return [
        ...guideActions,
        api.payload.rule(
          id,
          'svelte',
          'path-scoped Svelte 5 rune and component-authoring rule, loaded only when a Svelte file is in the working set',
        ),
        {
          kind: 'advise',
          text: "Svelte rule installed at .claude/rules/svelte.md, path-scoped via its `paths:` frontmatter (**/*.svelte, **/*.svelte.ts, **/*.svelte.js) so Claude Code loads it only when Svelte code is in the working set. Trim or widen `paths:` to where this repo's Svelte code actually lives. Keep the frontmatter — a rule file WITHOUT `paths:` is loaded on every turn. Install the `svelte-mcp` module separately for the Svelte MCP server (svelte-autofixer and live docs), since that config does not defer to this rule.",
          module: id,
        },
      ];
    },
  };
}

/**
 * Ships the three Svelte MCP server configs (HTTP, stdio, VS Code) as kit-owned files under
 * `.claude/mcp/`.
 *
 * A module of its own, not an option value of `svelteModule`, because the dependency runs
 * the other way: an MCP config does not defer to the base rule the way the SvelteKit guide
 * does. `svelte.md` mentions the server when this module is installed, but installing this
 * module requires nothing from `svelte.md` in return.
 *
 * `defaultEnabled(): false`, since installing three files still leaves the server
 * unconfigured until wired into `.mcp.json` or an editor's own MCP config, and the kit never
 * writes `.mcp.json` for the user.
 */
function svelteMcpModule(api: PluginApi): ModuleDef {
  const id = 'svelte-mcp';
  return {
    id,
    title: 'Svelte MCP server config (.claude/mcp/)',
    group: 'optional',
    hint(): string {
      return 'HTTP, stdio, and VS Code configs for the Svelte MCP server (svelte-autofixer, live docs)';
    },
    defaultEnabled(): boolean {
      return false;
    },
    plan(): Action[] {
      return [
        api.payload.file({
          module: id,
          srcRel: 'mcp/mcp.http.json',
          dest: '.claude/mcp/mcp.http.json',
          reason: 'Svelte MCP server config, HTTP transport',
        }),
        api.payload.file({
          module: id,
          srcRel: 'mcp/mcp.stdio.json',
          dest: '.claude/mcp/mcp.stdio.json',
          reason: 'Svelte MCP server config, stdio transport',
        }),
        api.payload.file({
          module: id,
          srcRel: 'mcp/vscode.mcp.json',
          dest: '.claude/mcp/vscode.mcp.json',
          reason: 'Svelte MCP server config for VS Code',
        }),
        {
          kind: 'advise',
          text: "Svelte MCP configs installed under .claude/mcp/: mcp.http.json, mcp.stdio.json, and vscode.mcp.json. None of these are wired in yet, since the kit never writes .mcp.json. Copy the `mcpServers` block from either mcp.http.json or mcp.stdio.json into this repo's own .mcp.json (http and stdio are alternatives, use one, not both), or for VS Code copy vscode.mcp.json into its own MCP config. An unused MCP server costs context on every turn, so remove it once you stop using it.",
          module: id,
        },
      ];
    },
  };
}

export default definePlugin((api: PluginApi): ModuleDef[] => [
  svelteModule(api),
  svelteMcpModule(api),
]);
