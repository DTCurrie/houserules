/**
 * The only module in this plugin that spawns a process. Everything else is pure and testable,
 * which is the whole reason the boundary is this narrow.
 *
 * No function here throws on a failed call. GitHub failures are ordinary control flow for a
 * sync: a missing scope, a revoked token, a rate limit. Callers branch on {@link GhResult}
 * instead of wrapping every call site in a try/catch, and each one prints its own remediation.
 */

import { spawnSync } from 'node:child_process';

export interface GhOk<TValue> {
  ok: true;
  value: TValue;
}

/**
 * A failed `gh` invocation.
 *
 * `status` is the HTTP status when one could be parsed out of the response, and null for a
 * spawn failure or a non-HTTP error. Callers key retry and abort decisions off it, so a 403
 * can end a run while a transient network error does not.
 */
export interface GhErr {
  ok: false;
  status: number | null;
  message: string;
}

export type GhResult<TValue> = GhOk<TValue> | GhErr;

export const ghOk = <TValue,>(value: TValue): GhOk<TValue> => ({
  ok: true,
  value,
});

export const ghErr = (
  message: string,
  status: number | null = null,
): GhErr => ({
  ok: false,
  status,
  message,
});

/** The authenticated user's permission flags on a repository. */
export interface RepoPermissions {
  admin: boolean;
  maintain: boolean;
  push: boolean;
  triage: boolean;
  pull: boolean;
}

const HTTP_STATUS_PATTERN = /HTTP (\d{3})/;
const TOKEN_SCOPES_LINE_PATTERN = /token scopes:\s*(.+)/i;
const QUOTED_SCOPE_PATTERN = /'([^']+)'/g;
const SSH_REMOTE_PATTERN = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/;
const HTTPS_REMOTE_PATTERN =
  /^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/;

/**
 * Pulls an HTTP status out of `gh`'s stderr, which reports it inline in lines such as
 * `gh: You are not authorized (HTTP 403)` or a bare `HTTP 404`. Returns null when stderr
 * carries no status, which callers treat as a non-HTTP failure.
 */
export function extractHttpStatus(stderr: string): number | null {
  const match = stderr.match(HTTP_STATUS_PATTERN);
  return match ? Number(match[1]) : null;
}

/**
 * The scope list out of `gh auth status`'s "Token scopes" line, lowercased and stripped of
 * their surrounding quotes.
 */
export function parseTokenScopes(authStatusOutput: string): string[] {
  const line = authStatusOutput
    .split('\n')
    .find((candidate) => TOKEN_SCOPES_LINE_PATTERN.test(candidate));
  if (!line) return [];

  const scopes: string[] = [];
  for (const match of line.matchAll(QUOTED_SCOPE_PATTERN)) {
    scopes.push(match[1]!.trim().toLowerCase());
  }
  return scopes;
}

/**
 * The owner and repo out of a GitHub remote URL, in either SSH (`git@github.com:owner/repo.git`)
 * or HTTPS (`https://github.com/owner/repo.git`) form. Null for anything else, including a
 * non-GitHub host.
 */
export function parseGitHubRemoteUrl(
  url: string,
): { owner: string; repo: string } | null {
  const trimmed = url.trim();
  const match =
    SSH_REMOTE_PATTERN.exec(trimmed) ?? HTTPS_REMOTE_PATTERN.exec(trimmed);
  return match ? { owner: match[1]!, repo: match[2]! } : null;
}

interface GraphqlEnvelope<TValue> {
  data?: TValue;
  errors?: Array<{ message?: string }>;
}

function isGraphqlEnvelope(value: unknown): value is GraphqlEnvelope<unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Unwraps a parsed `gh api graphql` response. A non-empty `errors` array is a {@link GhErr}
 * even though the transport succeeded, since GraphQL reports authorization failures at HTTP
 * 200 rather than as a non-zero exit.
 */
export function unwrapGraphqlEnvelope<TValue>(raw: unknown): GhResult<TValue> {
  if (!isGraphqlEnvelope(raw))
    return ghErr('gh api graphql did not return an object');

  if (raw.errors && raw.errors.length > 0) {
    return ghErr(raw.errors[0]!.message ?? 'gh api graphql returned an error');
  }

  return ghOk(raw.data as TValue);
}

interface GhInvocation {
  code: number;
  stdout: string;
  stderr: string;
}

function runGh(args: string[]): GhInvocation {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.error) {
    return { code: -1, stdout: '', stderr: result.error.message };
  }
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function parseJsonOutput<TValue>(stdout: string): GhResult<TValue> {
  try {
    return ghOk(JSON.parse(stdout) as TValue);
  } catch {
    return ghErr('gh api did not return valid JSON');
  }
}

/** Whether `gh` is on PATH at all. */
export function ghExists(): boolean {
  const result = spawnSync('gh', ['--version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

/**
 * The OAuth scopes on the current token, lowercased.
 *
 * Read from `gh auth status`, which prints them even when the API would reject a call for
 * lacking them. That ordering matters: the preflight has to name the missing scope rather than
 * surface whatever 403 the first real call produced.
 */
export function ghScopes(): GhResult<string[]> {
  const invocation = runGh(['auth', 'status']);
  // `gh auth status` writes its report to stderr, not stdout.
  const combined = `${invocation.stdout}\n${invocation.stderr}`;
  if (invocation.code !== 0) {
    return ghErr(
      invocation.stderr.trim() || 'gh auth status failed, run `gh auth login`',
      extractHttpStatus(invocation.stderr),
    );
  }
  return ghOk(parseTokenScopes(combined));
}

/** `gh api <path>`, optionally with `--jq <jq>`, parsed as JSON. */
function ghJson<TValue>(path: string, jq?: string): GhResult<TValue> {
  const args = ['api', path];
  if (jq) args.push('-q', jq);

  const invocation = runGh(args);
  if (invocation.code !== 0) {
    return ghErr(
      invocation.stderr.trim() || `gh api ${path} failed`,
      extractHttpStatus(invocation.stderr),
    );
  }
  return parseJsonOutput<TValue>(invocation.stdout);
}

/**
 * A GraphQL query or mutation, with `variables` passed as `-F key=value`.
 *
 * @returns The `data` field, already unwrapped. A response carrying a non-empty `errors`
 *   array is a {@link GhErr}, even when the transport succeeded, because GraphQL reports
 *   authorization failures at HTTP 200.
 */
export function ghGraphql<TValue>(
  query: string,
  variables?: Record<string, string | number | boolean>,
): GhResult<TValue> {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [key, value] of Object.entries(variables ?? {})) {
    args.push('-F', `${key}=${value}`);
  }

  const invocation = runGh(args);
  if (invocation.code !== 0) {
    return ghErr(
      invocation.stderr.trim() || 'gh api graphql failed',
      extractHttpStatus(invocation.stderr),
    );
  }

  const parsed = parseJsonOutput<unknown>(invocation.stdout);
  if (!parsed.ok) return parsed;
  return unwrapGraphqlEnvelope<TValue>(parsed.value);
}

/**
 * The repository the `origin` remote points at.
 *
 * @returns An error when there is no `origin`, or when it is not a GitHub remote. Both are
 *   ordinary states for a repo houserules is installed in, not exceptional ones.
 */
export function ghRepo(): GhResult<{ owner: string; repo: string }> {
  const result = spawnSync('git', ['remote', 'get-url', 'origin'], {
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    return ghErr('no `origin` remote found');
  }

  const url = result.stdout.trim();
  const parsed = parseGitHubRemoteUrl(url);
  return parsed
    ? ghOk(parsed)
    : ghErr(`origin remote is not a GitHub repository: ${url}`);
}

/**
 * `gh api repos/{owner}/{repo} -q .permissions`.
 *
 * Deliberately not `repos/{owner}/{repo}/collaborators/{login}/permission`, which returns the
 * same answer but requires more access than every caller of this has. A gate that itself needs
 * elevated access cannot gate anything.
 */
export function ghPermissions(
  owner: string,
  repo: string,
): GhResult<RepoPermissions> {
  const result = ghJson<Partial<RepoPermissions>>(
    `repos/${owner}/${repo}`,
    '.permissions',
  );
  if (!result.ok) return result;

  const permissions = result.value;
  return ghOk({
    admin: permissions.admin ?? false,
    maintain: permissions.maintain ?? false,
    push: permissions.push ?? false,
    triage: permissions.triage ?? false,
    pull: permissions.pull ?? false,
  });
}
