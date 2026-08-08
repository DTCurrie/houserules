import { describe, expect, it } from 'vitest';

import {
  extractHttpStatus,
  parseGitHubRemoteUrl,
  parseTokenScopes,
  unwrapGraphqlEnvelope,
} from '../gh.mjs';

describe('parseTokenScopes', () => {
  it.each([
    {
      name: 'single scope',
      output: "  - Token scopes: 'repo'\n",
      expected: ['repo'],
    },
    {
      name: 'five scopes, mixed case in the source',
      output:
        "  - Token scopes: 'Admin:Public_Key', 'Gist', 'Read:Org', 'Repo', 'Workflow'\n",
      expected: ['admin:public_key', 'gist', 'read:org', 'repo', 'workflow'],
    },
    {
      name: 'scope line among other auth status lines',
      output:
        "github.com\n  ✓ Logged in to github.com as octocat\n  - Token scopes: 'gist', 'repo'\n  ✓ Token: gho_****\n",
      expected: ['gist', 'repo'],
    },
    {
      name: 'no token scopes line at all',
      output: 'github.com\n  ✓ Logged in to github.com as octocat\n',
      expected: [],
    },
    { name: 'empty input', output: '', expected: [] },
  ])('extracts $expected from $name', ({ output, expected }) => {
    expect(parseTokenScopes(output)).toEqual(expected);
  });
});

describe('parseGitHubRemoteUrl', () => {
  it.each([
    {
      name: 'ssh remote with .git suffix',
      url: 'git@github.com:DTCurrie/agent-kit.git',
      expected: { owner: 'DTCurrie', repo: 'agent-kit' },
    },
    {
      name: 'https remote with .git suffix',
      url: 'https://github.com/DTCurrie/agent-kit.git',
      expected: { owner: 'DTCurrie', repo: 'agent-kit' },
    },
    {
      name: 'https remote without .git suffix',
      url: 'https://github.com/DTCurrie/agent-kit',
      expected: { owner: 'DTCurrie', repo: 'agent-kit' },
    },
    {
      name: 'ssh remote without .git suffix',
      url: 'git@github.com:DTCurrie/agent-kit',
      expected: { owner: 'DTCurrie', repo: 'agent-kit' },
    },
    {
      name: 'trailing newline from git remote get-url',
      url: 'git@github.com:DTCurrie/agent-kit.git\n',
      expected: { owner: 'DTCurrie', repo: 'agent-kit' },
    },
  ])('parses $name to $expected', ({ url, expected }) => {
    expect(parseGitHubRemoteUrl(url)).toEqual(expected);
  });

  it.each([
    'git@gitlab.com:DTCurrie/agent-kit.git',
    'https://gitlab.com/DTCurrie/agent-kit.git',
    'not a url at all',
    '',
  ])('returns null for a non-GitHub remote %j', (url) => {
    expect(parseGitHubRemoteUrl(url)).toBeNull();
  });
});

describe('extractHttpStatus', () => {
  it.each([
    {
      name: 'status in parentheses',
      stderr: 'gh: You are not authorized to perform this action (HTTP 403)',
      expected: 403,
    },
    {
      name: 'bare HTTP status',
      stderr: 'HTTP 404: Not Found',
      expected: 404,
    },
    {
      name: 'no status present',
      stderr: 'gh: could not resolve to a Repository',
      expected: null,
    },
    { name: 'empty stderr', stderr: '', expected: null },
  ])('extracts $expected from $name', ({ stderr, expected }) => {
    expect(extractHttpStatus(stderr)).toBe(expected);
  });
});

describe('unwrapGraphqlEnvelope', () => {
  it('returns the data field for a clean response', () => {
    const result = unwrapGraphqlEnvelope<{ viewer: { login: string } }>({
      data: { viewer: { login: 'octocat' } },
    });

    expect(result).toEqual({
      ok: true,
      value: { viewer: { login: 'octocat' } },
    });
  });

  it('returns a GhErr carrying the first message when errors is non-empty, even though the transport succeeded', () => {
    const result = unwrapGraphqlEnvelope({
      data: null,
      errors: [
        { message: 'Resource not accessible by integration' },
        { message: 'a second error' },
      ],
    });

    expect(result).toEqual({
      ok: false,
      status: null,
      message: 'Resource not accessible by integration',
    });
  });

  it('falls back to a generic message when an error entry carries none', () => {
    const result = unwrapGraphqlEnvelope({ errors: [{}] });

    expect(result).toEqual({
      ok: false,
      status: null,
      message: 'gh api graphql returned an error',
    });
  });

  it('errors on a non-object response instead of crashing', () => {
    expect(unwrapGraphqlEnvelope('not an object')).toEqual({
      ok: false,
      status: null,
      message: 'gh api graphql did not return an object',
    });
  });

  it('tolerates an empty errors array and still returns data', () => {
    const result = unwrapGraphqlEnvelope<{ viewer: string }>({
      data: { viewer: 'octocat' },
      errors: [],
    });

    expect(result).toEqual({ ok: true, value: { viewer: 'octocat' } });
  });
});
