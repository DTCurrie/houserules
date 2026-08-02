import { payloadPath } from '../paths.js';
import type { Action } from '../actions.js';
import type { ModuleGroup } from '../module-def.js';

export const id = 'terse-style';
export const title = 'Terse output style (token-lean responses)';
export const group: ModuleGroup = 'optional';

export function hint(): string {
  return '~60% fewer response tokens at a readability cost; activate via /config when wanted';
}

export function defaultEnabled(): boolean {
  return false;
}

/**
 * A caveman-inspired output style that cuts response tokens through terse phrasing.
 * Installing the file does not activate it. Output styles are user-selected, and the kit
 * never writes `outputStyle` into settings.json, which would clobber the user's choice.
 */
export function plan(): Action[] {
  return [
    {
      kind: 'copy',
      src: payloadPath('output-styles', 'kit-terse.md'),
      dest: '.claude/output-styles/kit-terse.md',
      module: id,
      reason: 'terse output style (opt-in via /config)',
    },
    {
      kind: 'advise',
      text: 'Terse style installed but NOT active: enable via /config → Output style → "Kit Terse", or set "outputStyle": "Kit Terse" in settings.local.json (the exact style name, not the kit-terse filename).',
      module: id,
    },
  ];
}
