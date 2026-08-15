import { join } from 'node:path';

import type { BodyAction, CopyAction } from './actions.js';

/**
 * How an MCP client reaches the server. `stdio` and `http` are the two Claude Code accepts in an
 * `mcpServers` block, and `vscode` is the same server under VS Code's own `servers` key, which is
 * a different file shape rather than a different transport. A union, not a string, so a typo is a
 * compile error instead of a config nobody can find.
 */
export type McpTransport = 'stdio' | 'http' | 'vscode';

/**
 * The action builders bound to one payload root. houserules binds them to its own payload, and
 * a plugin gets them bound to the payload inside its own package, so the same eight builders
 * serve both without either knowing where the other's files live.
 */
export interface PayloadBuilders {
  script(module: string, name: string, reason: string): CopyAction;
  lib(module: string, name: string): CopyAction;
  skill(module: string, name: string, reason: string): CopyAction;
  agent(module: string, name: string, reason: string): CopyAction;
  /**
   * `appendBody` is routing text composed from the user's selections, appended below the
   * payload rule's own body. Use it to link an OPTIONAL file, since a link shipped in the
   * payload dangles wherever that option was not chosen.
   */
  rule(
    module: string,
    name: string,
    reason: string,
    appendBody?: string,
  ): BodyAction;
  reference(module: string, name: string, reason: string): CopyAction;
  template(module: string, rel: string, reason?: string): CopyAction;
  /**
   * An MCP server config, namespaced by server name so two plugins shipping one cannot collide.
   *
   * The namespacing is the whole point of the builder. `plan.ts` dedupes a copy only when dest
   * AND src match, so two different sources at one dest is a real bug rather than something the
   * planner absorbs. A naming rule written down somewhere is forgettable. This is not.
   */
  mcp(
    module: string,
    server: string,
    transport: McpTransport,
    reason: string,
  ): CopyAction;
  /**
   * Escape hatch for a destination the named builders do not cover, such as
   * `.claude/output-styles/`. `srcRel` resolves inside this payload root, so a plugin never
   * computes a path into its own package.
   */
  file(args: {
    module: string;
    srcRel: string;
    dest: string;
    reason: string;
    mode?: number;
  }): CopyAction;
}

/**
 * Binds the payload action builders to `payloadRoot`, an absolute path to a built payload
 * directory.
 *
 * A plugin never calls this itself. houserules resolves the plugin's package, builds the
 * instance, and hands it to the plugin factory. Path resolution stays in one place, and a
 * plugin cannot accidentally emit actions pointing at houserules' payload.
 */
export function createPayloadBuilders(payloadRoot: string): PayloadBuilders {
  const at = (...segments: string[]) => join(payloadRoot, ...segments);

  return {
    script(module, name, reason) {
      return {
        kind: 'copy',
        src: at('scripts', name),
        dest: `.claude/scripts/${name}`,
        mode: 0o755,
        module,
        reason,
      };
    },

    lib(module, name) {
      return {
        kind: 'copy',
        src: at('scripts', 'lib', name),
        dest: `.claude/scripts/lib/${name}`,
        module,
        reason: 'shared script library',
      };
    },

    skill(module, name, reason) {
      return {
        kind: 'copy',
        src: at('skills', name, 'SKILL.md'),
        dest: `.claude/skills/${name}/SKILL.md`,
        module,
        reason,
      };
    },

    agent(module, name, reason) {
      return {
        kind: 'copy',
        src: at('agents', `${name}.md`),
        dest: `.claude/agents/${name}.md`,
        module,
        reason,
      };
    },

    rule(module, name, reason, appendBody) {
      const action: BodyAction = {
        kind: 'body',
        src: at('rules', `${name}.md`),
        dest: `.claude/rules/${name}.md`,
        module,
        reason,
      };
      if (appendBody) action.appendBody = appendBody;
      return action;
    },

    reference(module, name, reason) {
      return {
        kind: 'copy',
        src: at('reference', `${name}.md`),
        dest: `.claude/reference/${name}.md`,
        module,
        reason,
      };
    },

    template(module, rel, reason = 'reference template') {
      return {
        kind: 'copy',
        src: at('templates', ...rel.split('/')),
        dest: `.claude/templates/${rel}`,
        module,
        reason,
      };
    },

    mcp(module, server, transport, reason) {
      return {
        kind: 'copy',
        src: at('mcp', `${server}.${transport}.json`),
        dest: `.claude/mcp/${server}.${transport}.json`,
        module,
        reason,
      };
    },

    file({ module, srcRel, dest, reason, mode }) {
      const action: CopyAction = {
        kind: 'copy',
        src: at(...srcRel.split('/')),
        dest,
        module,
        reason,
      };
      if (mode !== undefined) action.mode = mode;
      return action;
    },
  };
}
