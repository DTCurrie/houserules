import { describe, expect, it } from 'vitest';

import { isManualMode } from '../permission-mode.mjs';

describe('isManualMode', () => {
  it('reads a "default" permission_mode as manual', () => {
    expect(isManualMode({ permission_mode: 'default' })).toBe(true);
  });

  it.each(['acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'])(
    'reads a "%s" permission_mode as not manual',
    (mode) => {
      expect(isManualMode({ permission_mode: mode })).toBe(false);
    },
  );

  it('reads a payload with no permission_mode as not manual', () => {
    expect(isManualMode({ hook_event_name: 'Stop' })).toBe(false);
  });

  it.each([null, undefined, 'default'])(
    'reads a non-object payload (%s) as not manual',
    (payload) => {
      expect(isManualMode(payload)).toBe(false);
    },
  );
});
