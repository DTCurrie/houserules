import { describe, expect, it } from 'vitest';

import {
  evaluateGate,
  evaluateReadGate,
  type GateInputs,
  type GateVerdict,
} from '../sync-gate.mjs';
import type { RepoPermissions } from '../gh.mjs';

const PUSH_ONLY: RepoPermissions = {
  admin: false,
  maintain: false,
  push: true,
  triage: true,
  pull: true,
};

const MAINTAIN: RepoPermissions = {
  admin: false,
  maintain: true,
  push: true,
  triage: true,
  pull: true,
};

const ADMIN: RepoPermissions = {
  admin: true,
  maintain: true,
  push: true,
  triage: true,
  pull: true,
};

const NO_ACCESS: RepoPermissions = {
  admin: false,
  maintain: false,
  push: false,
  triage: false,
  pull: false,
};

const PERMISSION_CASES: {
  label: string;
  permissions: RepoPermissions | null;
}[] = [
  { label: 'unknown', permissions: null },
  { label: 'push-only', permissions: PUSH_ONLY },
  { label: 'maintain', permissions: MAINTAIN },
  { label: 'admin', permissions: ADMIN },
];
const AUTO_SYNC_CASES: { label: string; autoSync: boolean | undefined }[] = [
  { label: 'unset', autoSync: undefined },
  { label: 'true', autoSync: true },
  { label: 'false', autoSync: false },
];

function expectedReason(
  hasEnableToken: boolean,
  autoSync: boolean | undefined,
  permissions: RepoPermissions | null,
): string {
  if (!hasEnableToken) return 'no-token';
  if (autoSync === false) return 'auto-sync-disabled';
  if (permissions === null) return 'permission-unknown';
  if (!permissions.maintain && !permissions.admin)
    return 'insufficient-permission';
  return 'allowed';
}

function reasonOf(verdict: GateVerdict): string {
  return verdict.allowed ? 'allowed' : verdict.reason;
}

function inputs(overrides: Partial<GateInputs>): GateInputs {
  return {
    hasEnableToken: true,
    autoSync: undefined,
    permissions: MAINTAIN,
    ...overrides,
  };
}

describe('evaluateGate', () => {
  const table = [true, false].flatMap((hasEnableToken) =>
    AUTO_SYNC_CASES.flatMap(({ label: autoSyncLabel, autoSync }) =>
      PERMISSION_CASES.map(({ label: permissionLabel, permissions }) => ({
        hasEnableToken,
        autoSync,
        permissions,
        label: `token=${hasEnableToken} autoSync=${autoSyncLabel} permissions=${permissionLabel}`,
        reason: expectedReason(hasEnableToken, autoSync, permissions),
      })),
    ),
  );

  it.each(table)(
    '$label -> $reason',
    ({ hasEnableToken, autoSync, permissions, reason }) => {
      const verdict = evaluateGate({ hasEnableToken, autoSync, permissions });

      expect(reasonOf(verdict)).toBe(reason);
    },
  );

  it('denies committed autoSync:false even for an admin with the token', () => {
    const verdict = evaluateGate(
      inputs({ hasEnableToken: true, autoSync: false, permissions: ADMIN }),
    );

    expect(verdict).toEqual({
      allowed: false,
      reason: 'auto-sync-disabled',
      message: expect.any(String),
    });
  });

  it('denies an admin with autoSync:true but no local token, as no-token', () => {
    const verdict = evaluateGate(
      inputs({ hasEnableToken: false, autoSync: true, permissions: ADMIN }),
    );

    expect(verdict).toEqual({
      allowed: false,
      reason: 'no-token',
      message: expect.any(String),
    });
  });

  it('denies push-only permission with the token and no autoSync setting', () => {
    const verdict = evaluateGate(
      inputs({
        hasEnableToken: true,
        autoSync: undefined,
        permissions: PUSH_ONLY,
      }),
    );

    expect(verdict).toEqual({
      allowed: false,
      reason: 'insufficient-permission',
      message: expect.any(String),
    });
  });

  it('allows maintain permission with the token and no autoSync setting', () => {
    const verdict = evaluateGate(
      inputs({
        hasEnableToken: true,
        autoSync: undefined,
        permissions: MAINTAIN,
      }),
    );

    expect(verdict).toEqual({ allowed: true });
  });

  it('ranks no-token above every other denial', () => {
    const verdict = evaluateGate({
      hasEnableToken: false,
      autoSync: false,
      permissions: null,
    });

    expect(reasonOf(verdict)).toBe('no-token');
  });

  it('ranks auto-sync-disabled above unknown permissions', () => {
    const verdict = evaluateGate({
      hasEnableToken: true,
      autoSync: false,
      permissions: null,
    });

    expect(reasonOf(verdict)).toBe('auto-sync-disabled');
  });

  it('ranks auto-sync-disabled above insufficient permission', () => {
    const verdict = evaluateGate({
      hasEnableToken: true,
      autoSync: false,
      permissions: PUSH_ONLY,
    });

    expect(reasonOf(verdict)).toBe('auto-sync-disabled');
  });

  it('ranks unknown permissions above insufficient permission', () => {
    const verdict = evaluateGate({
      hasEnableToken: true,
      autoSync: undefined,
      permissions: null,
    });

    expect(reasonOf(verdict)).toBe('permission-unknown');
  });

  it('mentions the issues tab and /backlog-adopt in the insufficient-permission message', () => {
    const verdict = evaluateGate(
      inputs({
        hasEnableToken: true,
        autoSync: undefined,
        permissions: PUSH_ONLY,
      }),
    );

    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error('unreachable');
    expect(verdict.message).toMatch(/issues tab/);
    expect(verdict.message).toMatch(/\/backlog-adopt/);
  });
});

describe('evaluateReadGate', () => {
  it('allows a pull-only account with no local enable token', () => {
    const verdict = evaluateReadGate({
      hasEnableToken: false,
      autoSync: undefined,
      permissions: PUSH_ONLY,
    });

    expect(verdict).toEqual({ allowed: true });
  });

  it('allows maintain permission', () => {
    const verdict = evaluateReadGate({
      hasEnableToken: false,
      autoSync: undefined,
      permissions: MAINTAIN,
    });

    expect(verdict).toEqual({ allowed: true });
  });

  it('denies with auto-sync-disabled when autoSync is false', () => {
    const verdict = evaluateReadGate({
      hasEnableToken: false,
      autoSync: false,
      permissions: ADMIN,
    });

    expect(verdict).toEqual({
      allowed: false,
      reason: 'auto-sync-disabled',
      message: expect.any(String),
    });
  });

  it('denies with permission-unknown when permissions is null', () => {
    const verdict = evaluateReadGate({
      hasEnableToken: false,
      autoSync: undefined,
      permissions: null,
    });

    expect(verdict).toEqual({
      allowed: false,
      reason: 'permission-unknown',
      message: expect.any(String),
    });
  });

  it('denies with insufficient-permission when the account has no repository access', () => {
    const verdict = evaluateReadGate({
      hasEnableToken: false,
      autoSync: undefined,
      permissions: NO_ACCESS,
    });

    expect(verdict).toEqual({
      allowed: false,
      reason: 'insufficient-permission',
      message: expect.any(String),
    });
  });

  it('does not require the local enable token to allow a read', () => {
    const withToken = evaluateReadGate({
      hasEnableToken: true,
      autoSync: undefined,
      permissions: PUSH_ONLY,
    });
    const withoutToken = evaluateReadGate({
      hasEnableToken: false,
      autoSync: undefined,
      permissions: PUSH_ONLY,
    });

    expect(withToken).toEqual({ allowed: true });
    expect(withoutToken).toEqual({ allowed: true });
  });
});
