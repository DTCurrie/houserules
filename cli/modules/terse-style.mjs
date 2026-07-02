// terse-style module (claude-kit CLI): a caveman-inspired output style that cuts
// response tokens via terse phrasing. Installing the file does NOT activate it —
// output styles are user-selected — and the kit never writes `outputStyle` into
// settings.json (that would silently clobber the user's choice).

import { payloadPath } from '../paths.mjs';

export const id = 'terse-style';
export const title = 'Terse output style (token-lean responses)';
export const group = 'optional';

export function hint() {
  return '~60% fewer response tokens at a readability cost; activate via /config when wanted';
}

export function defaultEnabled() {
  return false;
}

export function plan() {
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
      text: 'Terse style installed but NOT active: enable it per-session/user via /config → Output style → "Kit Terse".',
      module: id,
    },
  ];
}
