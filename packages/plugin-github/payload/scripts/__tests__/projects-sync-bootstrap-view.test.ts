import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { runIn, runScript } from '#test/run';

const SCRIPT = '.claude/scripts/projects-sync.mjs';
const PLUGIN_DIR = fileURLToPath(new URL('../../..', import.meta.url));

const GH_STUB = `#!/usr/bin/env node
const { readFileSync, writeFileSync, existsSync, appendFileSync } = require('node:fs');

const STATE_PATH = 'gh-state.json';
const CALLS_PATH = 'gh-graphql-calls.log';

function loadState() {
  if (!existsSync(STATE_PATH)) return { counter: 0, projects: {} };
  return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
}

function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state));
}

function slug(name) {
  return \`field-\${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}\`;
}

const args = process.argv.slice(2);

if (args[0] === '--version') process.exit(0);

if (args[0] === 'auth' && args[1] === 'status') {
  process.stderr.write("Logged in to github.com as octocat\\n  - Token scopes: 'repo', 'project'\\n");
  process.exit(0);
}

if (args[0] === 'api' && typeof args[1] === 'string' && args[1].startsWith('repos/')) {
  console.log(JSON.stringify({ admin: true, maintain: true, push: true, triage: true, pull: true }));
  process.exit(0);
}

if (args[0] === 'api' && args[1] === 'graphql') {
  const query = args[3].slice('query='.length);
  appendFileSync(CALLS_PATH, \`\${query}\\n\`);
  const state = loadState();

  if (query.includes('repositoryOwner(login:')) {
    const nodes = Object.entries(state.projects).map(([id, project]) => ({
      id,
      number: project.number,
      title: project.title,
      fields: { nodes: Object.keys(project.fields).map((name) => ({ name })) },
    }));
    console.log(JSON.stringify({ data: { repositoryOwner: { id: 'owner-id', projectsV2: { nodes } } } }));
    process.exit(0);
  }

  if (query.includes('repository(owner:')) {
    console.log(JSON.stringify({ data: { repository: { id: 'repo-id' } } }));
    process.exit(0);
  }

  if (query.includes('createProjectV2(input:')) {
    const titleMatch = query.match(/title: "([^"]+)"/);
    state.counter += 1;
    const id = \`proj-\${state.counter}\`;
    const number = state.counter;
    state.projects[id] = {
      number,
      title: titleMatch[1],
      fields: {
        Title: 'field-title',
        Status: 'field-status',
        'Linked pull requests': 'field-linked-pull-requests',
        'Sub-issues progress': 'field-sub-issues-progress',
      },
      view: { id: \`view-\${id}\`, number: 1, name: 'View 1', layout: 'TABLE_LAYOUT', visibleFieldIds: [] },
    };
    saveState(state);
    console.log(JSON.stringify({ data: { createProjectV2: { projectV2: { id, number } } } }));
    process.exit(0);
  }

  if (query.includes('linkProjectV2ToRepository(input:')) {
    console.log(JSON.stringify({ data: { linkProjectV2ToRepository: { repository: { id: 'repo-id' } } } }));
    process.exit(0);
  }

  if (query.includes('createProjectV2Field(input:')) {
    const projectId = query.match(/projectId: "([^"]+)"/)[1];
    const fieldName = query.match(/name: "([^"]+)"/)[1];
    const fieldId = slug(fieldName);
    state.projects[projectId].fields[fieldName] = fieldId;
    saveState(state);
    console.log(JSON.stringify({ data: { createProjectV2Field: { projectV2Field: { id: fieldId } } } }));
    process.exit(0);
  }

  if (query.includes('updateProjectV2Field(input:')) {
    const fieldId = query.match(/fieldId: "([^"]+)"/)[1];
    console.log(JSON.stringify({ data: { updateProjectV2Field: { projectV2Field: { id: fieldId } } } }));
    process.exit(0);
  }

  if (query.includes('fields(first: 50)')) {
    const projectId = query.match(/node\\(id: "([^"]+)"\\)/)[1];
    const project = state.projects[projectId];
    const nodes = Object.entries(project.fields).map(([name, id]) => ({ id, name }));
    console.log(JSON.stringify({ data: { node: { fields: { nodes } } } }));
    process.exit(0);
  }

  if (query.includes('views(first: 1)')) {
    const projectId = query.match(/node\\(id: "([^"]+)"\\)/)[1];
    const project = state.projects[projectId];
    console.log(JSON.stringify({ data: { node: { views: { nodes: [{ id: project.view.id, number: project.view.number }] } } } }));
    process.exit(0);
  }

  if (query.includes('updateProjectV2View(input:')) {
    const viewId = query.match(/viewId: "([^"]+)"/)[1];
    const name = query.match(/name: "([^"]+)"/)[1];
    const layout = query.match(/layout: (\\w+)/)[1];
    const idsRaw = query.match(/visibleFieldIds: \\[([^\\]]*)\\]/)[1];
    const ids = idsRaw
      .split(',')
      .map((entry) => entry.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
    const project = Object.values(state.projects).find((candidate) => candidate.view.id === viewId);
    project.view = { ...project.view, name, layout, visibleFieldIds: ids };
    saveState(state);
    console.log(JSON.stringify({ data: { updateProjectV2View: { projectV2View: { id: viewId } } } }));
    process.exit(0);
  }

  process.exit(1);
}

process.exit(1);
`;

interface GhProjectState {
  number: number;
  title: string;
  fields: Record<string, string>;
  view: {
    id: string;
    number: number;
    name: string;
    layout: string;
    visibleFieldIds: string[];
  };
}

interface GhState {
  counter: number;
  projects: Record<string, GhProjectState>;
}

function stage(): string {
  const root = useInstalledRepo('pnpm-monorepo', {
    modules: 'projects/projects',
    plugins: [{ name: PLUGIN_DIR, alias: 'projects' }],
  });
  runIn(root, 'git', [
    'remote',
    'add',
    'origin',
    'https://github.com/octocat/hello-world.git',
  ]);
  return root;
}

function run(root: string) {
  return runScript(root, SCRIPT, { args: ['bootstrap'] });
}

function readState(root: string): GhState {
  return JSON.parse(readFileSync(join(root, 'gh-state.json'), 'utf8'));
}

function projectByTitle(state: GhState, title: string): GhProjectState {
  const found = Object.values(state.projects).find(
    (project) => project.title === title,
  );
  if (!found) throw new Error(`no project titled "${title}" in gh-state.json`);
  return found;
}

const BACKLOG_FIELDS = [
  'Status',
  'Iteration',
  'Estimate',
  'Priority',
  'Area',
  'Filed',
  'Chat',
];
const DECISIONS_FIELDS = [
  'Status',
  'Decided',
  'Supersedes',
  'Superseded by',
  'Chat',
  'Scope',
  'Under',
  'Area',
];
const BUILTIN_FIELDS = [
  'Title',
  'Status',
  'Linked pull requests',
  'Sub-issues progress',
];

function slug(name: string): string {
  return `field-${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')}`;
}

function seedExistingBoards(root: string): void {
  const fieldsFor = (names: readonly string[]) =>
    Object.fromEntries(
      [...BUILTIN_FIELDS, ...names].map((name) => [name, slug(name)]),
    );
  const state: GhState = {
    counter: 2,
    projects: {
      'proj-1': {
        number: 1,
        title: 'hello-world Backlog',
        fields: fieldsFor(BACKLOG_FIELDS),
        view: {
          id: 'view-proj-1',
          number: 1,
          name: 'View 1',
          layout: 'TABLE_LAYOUT',
          visibleFieldIds: [],
        },
      },
      'proj-2': {
        number: 2,
        title: 'hello-world Decisions',
        fields: fieldsFor(DECISIONS_FIELDS),
        view: {
          id: 'view-proj-2',
          number: 1,
          name: 'View 1',
          layout: 'TABLE_LAYOUT',
          visibleFieldIds: [],
        },
      },
    },
  };
  writeFileSync(join(root, 'gh-state.json'), JSON.stringify(state));
}

describe('projects-sync bootstrap, default view configuration', () => {
  let stubDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    stubDir = mkdtempSync(join(tmpdir(), 'gh-stub-'));
    const ghPath = join(stubDir, 'gh');
    writeFileSync(ghPath, GH_STUB);
    chmodSync(ghPath, 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = `${stubDir}${process.env.PATH ? `:${process.env.PATH}` : ''}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    rmSync(stubDir, { recursive: true, force: true });
  });

  it.each([
    {
      title: 'hello-world Backlog',
      layout: 'BOARD_LAYOUT',
      visibleFieldNames: [
        'Title',
        'Status',
        'Linked pull requests',
        'Sub-issues progress',
        'Area',
      ],
      viewName: 'Backlog',
    },
    {
      title: 'hello-world Decisions',
      layout: 'TABLE_LAYOUT',
      visibleFieldNames: [
        'Title',
        'Supersedes',
        'Chat',
        'Superseded by',
        'Scope',
        'Area',
      ],
      viewName: 'Decisions',
    },
  ])(
    'configures the $title default view with the layout and fields the issue specifies',
    ({ title, layout, visibleFieldNames, viewName }) => {
      const root = stage();

      const result = run(root);

      expect(result.status).toBe(0);
      const project = projectByTitle(readState(root), title);
      expect(project.view.name).toBe(viewName);
      expect(project.view.layout).toBe(layout);
      expect(project.view.visibleFieldIds).toEqual(visibleFieldNames.map(slug));
    },
  );

  it('leaves an existing board untouched, including its saved view', () => {
    const root = stage();
    seedExistingBoards(root);

    const result = run(root);

    expect(result.status).toBe(0);
    const state = readState(root);
    for (const title of ['hello-world Backlog', 'hello-world Decisions']) {
      const project = projectByTitle(state, title);
      expect(project.view.name).toBe('View 1');
      expect(project.view.visibleFieldIds).toEqual([]);
    }
    expect(existsSync(join(root, 'gh-graphql-calls.log'))).toBe(true);
    const calls = readFileSync(join(root, 'gh-graphql-calls.log'), 'utf8');
    expect(calls).not.toContain('updateProjectV2View');
    expect(calls).not.toContain('views(first: 1)');
  });
});
