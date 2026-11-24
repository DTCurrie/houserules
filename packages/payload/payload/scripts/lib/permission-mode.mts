// Claude Code sends manual mode, where the user approves each edit, as "default", never "manual".
const MANUAL_PERMISSION_MODE = 'default';

/**
 * Whether a hook payload says the user reviews each edit by hand. A payload with no
 * `permission_mode`, as an older Claude Code sends, reads as not manual, so the hook
 * behaves as it did before the field existed.
 */
export function isManualMode(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const mode = (payload as { permission_mode?: unknown }).permission_mode;
  return mode === MANUAL_PERMISSION_MODE;
}
