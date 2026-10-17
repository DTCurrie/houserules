import { describe, expect, it } from 'vitest';

import { plan } from '../read-guard.js';

describe('read-guard plan', () => {
  it('fails closed on the guard-read hook', () => {
    const hooks = plan()
      .filter(
        (a): a is Extract<typeof a, { kind: 'merge-settings' }> =>
          a.kind === 'merge-settings',
      )
      .flatMap((a) => a.fragment.hooks?.PreToolUse ?? [])
      .filter((group) => group.matcher === 'Read')
      .flatMap((group) => group.hooks);

    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.command).toContain('guard-read.mjs');
    expect(hooks[0]!.onFailure).toBe('block');
  });
});
