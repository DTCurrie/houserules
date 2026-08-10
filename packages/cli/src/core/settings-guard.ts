import type { Ctx } from '../detect.js';

/**
 * The message to report when `.claude/settings.json` failed to parse, or null when it
 * parsed fine (or is absent). Shared by every entry point that must refuse to plan
 * against a settings file it cannot trust, so the wording travels with one call site
 * instead of three.
 */
export function settingsParseErrorMessage(ctx: Ctx): string | null {
  if (!ctx.claude.settingsParseError) return null;
  return `.claude/settings.json is not valid JSON (${ctx.claude.settingsParseError}). Fix it by hand first.`;
}
