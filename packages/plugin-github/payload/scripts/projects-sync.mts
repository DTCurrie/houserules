#!/usr/bin/env node
/**
 * GitHub Projects sync CLI.
 *
 * Usage:
 *   bootstrap [--dry-run]  # create or adopt one project per (backlog, decisions)
 *   push [--dry-run]       # drain the push queue to the live boards, then compact
 *   pull [--dry-run]       # rebuild the local index from the boards
 *   backfill [--dry-run]   # bring an existing board up to the current field schema
 *   compact [--dry-run]    # shrink the local ledgers to what a push still owes
 *   status                 # print the resolved project per ledger, and gate state
 *
 * bootstrap, push, and backfill need the local enable token (<ledger dir>/.projects.json) and
 * maintain or admin on the repository. pull needs neither. status prints the current gate state.
 *
 * --dry-run runs every read the same way a real run would, but prints each planned step
 * instead of creating, linking, or pushing anything.
 *
 * Exit codes: 0 on success or bare usage, 1 on a preflight failure, a gate denial, a failed
 * push op, or any `gh` error.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { loadConfigSafe, repoRoot } from '@agent-kit/payload/kit-config';
import {
  appendEvent,
  ledgerDir,
  ledgerPath,
  nowIso,
  decodeBody,
  readLog,
} from '@agent-kit/payload/entry-ledger';
import {
  ghErr,
  ghExists,
  ghGraphql,
  ghOk,
  ghPermissions,
  ghRepo,
  ghScopes,
} from './lib/gh.mjs';
import type { GhResult } from './lib/gh.mjs';
import {
  ENABLE_TOKEN_BASENAME,
  evaluateGate,
  evaluateReadGate,
  readGateInputs,
} from './lib/sync-gate.mjs';
import {
  emptyIndex,
  indexBasename,
  loadIndex,
  serializeIndex,
} from '@agent-kit/payload/ledger-index';
import type { LedgerIndex } from '@agent-kit/payload/ledger-index';
import {
  describeStep,
  planBootstrap,
  planIsNoop,
} from './lib/bootstrap-plan.mjs';
import type { BootstrapStep, ExistingProject } from './lib/bootstrap-plan.mjs';
import {
  appendMarker,
  areaForSurface,
  fieldsFor,
  projectTitle,
} from './lib/project-shape.mjs';
import type { FieldSpec, LedgerKind } from './lib/project-shape.mjs';
import {
  buildPushQueue,
  describeOp,
  resolveMarkSupersededItemId,
  summarizeQueue,
  syncedRecord,
} from './lib/push-queue.mjs';
import type { LedgerRecord, PushOp } from './lib/push-queue.mjs';
import {
  backfillFieldValue,
  fieldValueLiteral,
  fieldValuesFor,
} from './lib/item-fields.mjs';
import type { FieldValue } from './lib/item-fields.mjs';
import {
  compactBacklog,
  compactDecisions,
  compactionIsNoop,
  describeCompaction,
  pendingEntryIds,
  serializeLedger,
} from './lib/ledger-compaction.mjs';
import type { CompactionResult } from './lib/ledger-compaction.mjs';
import { projectBoardItems } from './lib/board-projection.mjs';
import type { BoardEntry, BoardItem } from './lib/board-projection.mjs';
import {
  backfillIsNoop,
  describeBackfillOp,
  planBackfill,
} from './lib/backfill-plan.mjs';
import type { BackfillOp, LocalEntry } from './lib/backfill-plan.mjs';

const REPO_ROOT = repoRoot();
const CONFIG = loadConfigSafe();
const LEDGER_DIRECTORY = ledgerDir(REPO_ROOT, CONFIG.ledgers?.dir);
const LEDGER_KINDS: readonly LedgerKind[] = ['backlog', 'decisions'];

function autoSyncSetting(): boolean | undefined {
  return (CONFIG.projects as { autoSync?: boolean } | undefined)?.autoSync;
}

/**
 * The key one board is stored under in `.projects.json`.
 *
 * The ledger kind alone. There is one board per kind per repo, and a target is carried by each
 * item's `Area` field rather than by which board it sits on.
 */
function projectKey(kind: LedgerKind): string {
  return kind;
}

/** Confirms `gh` is usable and returns the GitHub owner and repo `origin` points at. */
function preflight(): { owner: string; repo: string } {
  if (!ghExists()) {
    console.error(
      '`gh` is not on PATH. Install the GitHub CLI: https://cli.github.com/',
    );
    process.exit(1);
  }

  const scopes = ghScopes();
  if (!scopes.ok) {
    console.error(`gh auth status failed: ${scopes.message}`);
    console.error('Run `gh auth login` to authenticate.');
    process.exit(1);
  }
  if (!scopes.value.includes('project')) {
    console.error('The authenticated token is missing the `project` scope.');
    console.error('Run `gh auth refresh -s project`');
    process.exit(1);
  }

  const repo = ghRepo();
  if (!repo.ok) {
    if (repo.message.includes('no `origin` remote found')) {
      console.error(
        'No `origin` remote found. Add one: git remote add origin <url>.',
      );
    } else {
      console.error(
        `${repo.message}. projects sync only supports GitHub repositories.`,
      );
    }
    process.exit(1);
  }

  return repo.value;
}

/**
 * Denies unless the caller passes the sync gate, with one exception: `bootstrap` may run
 * before the local enable token exists, since it is what creates it. In that case it still
 * has to pass the same permission and auto-sync checks the gate would otherwise apply.
 */
function checkGate(action: string, owner: string, repo: string): void {
  const autoSync = autoSyncSetting();
  const verdict = evaluateGate(readGateInputs(LEDGER_DIRECTORY, autoSync));
  if (verdict.allowed) return;

  const bootstrapBeforeToken =
    action === 'bootstrap' && verdict.reason === 'no-token';
  if (!bootstrapBeforeToken) {
    console.error(verdict.message);
    process.exit(1);
  }

  if (autoSync === false) {
    console.error(
      'projects.autoSync is set to false in kit.config.json. A maintainer turned sync off for this repo.',
    );
    process.exit(1);
  }
  const permissions = ghPermissions(owner, repo);
  if (
    !permissions.ok ||
    (!permissions.value.maintain && !permissions.value.admin)
  ) {
    console.error(
      'bootstrap needs maintain or admin access on this repository. Ask a maintainer to run it.',
    );
    process.exit(1);
  }
}

/**
 * Denies unless the caller passes the READ gate. Weaker than {@link checkGate}: `pull` needs no
 * local enable token and no maintain access, only ordinary read access to the repository, since
 * the point of `pull` is to let a contributor without write access hold a local index.
 *
 * The permission call is skipped when `autoSync` already denies, the same short circuit
 * {@link readGateInputs} uses, so the common case costs no network round trip.
 */
function checkReadGate(): void {
  const verdict = evaluateReadGate(
    readGateInputs(LEDGER_DIRECTORY, autoSyncSetting(), {
      requireToken: false,
    }),
  );
  if (!verdict.allowed) {
    console.error(verdict.message);
    process.exit(1);
  }
}

interface OwnerProjectsResponse {
  repositoryOwner: {
    id: string;
    projectsV2: {
      nodes: {
        id: string;
        number: number;
        title: string;
        fields: { nodes: { name?: string }[] };
      }[];
    };
  } | null;
}

/** The owner's node id and every project already under it, with the fields each carries. */
function fetchOwnerProjects(
  owner: string,
): GhResult<{ ownerId: string; projects: ExistingProject[] }> {
  const query = `query { repositoryOwner(login: ${JSON.stringify(owner)}) {
    id
    ... on ProjectV2Owner {
      projectsV2(first: 100) {
        nodes {
          id
          number
          title
          fields(first: 50) { nodes { ... on ProjectV2FieldCommon { name } } }
        }
      }
    }
  } }`;

  const result = ghGraphql<OwnerProjectsResponse>(query);
  if (!result.ok) return result;
  if (!result.value.repositoryOwner)
    return ghErr(`GitHub has no owner named ${owner}`);

  const { id, projectsV2 } = result.value.repositoryOwner;
  const projects: ExistingProject[] = projectsV2.nodes.map((node) => ({
    id: node.id,
    number: node.number,
    title: node.title,
    fieldNames: node.fields.nodes
      .map((field) => field.name)
      .filter((name): name is string => typeof name === 'string'),
  }));
  return ghOk({ ownerId: id, projects });
}

function fetchRepositoryId(owner: string, repo: string): GhResult<string> {
  const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { id } }`;
  const result = ghGraphql<{ repository: { id: string } | null }>(query);
  if (!result.ok) return result;
  return result.value.repository
    ? ghOk(result.value.repository.id)
    : ghErr(`GitHub has no repository ${owner}/${repo}`);
}

function createProject(
  ownerId: string,
  title: string,
): GhResult<{ id: string; number: number }> {
  const query = `mutation { createProjectV2(input: { ownerId: ${JSON.stringify(ownerId)}, title: ${JSON.stringify(title)} }) { projectV2 { id number } } }`;
  const result = ghGraphql<{
    createProjectV2: { projectV2: { id: string; number: number } };
  }>(query);
  return result.ok ? ghOk(result.value.createProjectV2.projectV2) : result;
}

function linkProjectToRepository(
  projectId: string,
  repositoryId: string,
): GhResult<void> {
  const query = `mutation { linkProjectV2ToRepository(input: { projectId: ${JSON.stringify(projectId)}, repositoryId: ${JSON.stringify(repositoryId)} }) { repository { id } } }`;
  const result = ghGraphql<{
    linkProjectV2ToRepository: { repository: { id: string } };
  }>(query);
  return result.ok ? ghOk(undefined) : result;
}

/**
 * The `createProjectV2Field` input fields specific to one field's data type. Built as a
 * literal rather than passed through `-F` variables, since `gh api graphql` variables carry
 * only scalars and this needs arrays and nested objects.
 *
 * Every single-select option sends `name`, `color`, and `description`. All three are required
 * by `ProjectV2SingleSelectFieldOptionInput`, and omitting `description` fails the whole
 * mutation rather than defaulting it.
 */
function fieldConfigLiteral(field: FieldSpec): string {
  if (field.dataType === 'SINGLE_SELECT') {
    const options = field.options
      .map(
        (option) =>
          `{ name: ${JSON.stringify(option.name)}, color: ${option.color}, description: ${JSON.stringify(option.description)} }`,
      )
      .join(', ');
    return `singleSelectOptions: [${options}]`;
  }
  if (field.dataType === 'ITERATION') {
    // `iterations` is required by ProjectV2IterationFieldConfigurationInput and an empty array
    // is accepted, which is what we want: GitHub seeds the first iteration itself, and picking
    // sprint dates on a maintainer's behalf is not this script's decision to make.
    return `iterationConfiguration: { startDate: ${JSON.stringify(field.iteration.startDate)}, duration: ${field.iteration.duration}, iterations: [] }`;
  }
  return '';
}

/** `createProjectV2Field` takes the name and the data type as well as the configuration. */
function createFieldInputLiteral(field: FieldSpec): string {
  const base = `name: ${JSON.stringify(field.name)}, dataType: ${field.dataType}`;
  const config = fieldConfigLiteral(field);
  return config ? `${base}, ${config}` : base;
}

/**
 * `updateProjectV2Field` takes the configuration alone. It rejects `dataType` outright, since a
 * field's type is fixed once it exists, and passing `name` would rewrite the name we matched on.
 */
function updateFieldInputLiteral(field: FieldSpec): string {
  return fieldConfigLiteral(field);
}

function createField(projectId: string, field: FieldSpec): GhResult<void> {
  const query = `mutation { createProjectV2Field(input: { projectId: ${JSON.stringify(projectId)}, ${createFieldInputLiteral(field)} }) { projectV2Field { ... on ProjectV2FieldCommon { id } } } }`;
  const result = ghGraphql<{
    createProjectV2Field: { projectV2Field: { id: string } };
  }>(query);
  return result.ok ? ghOk(undefined) : result;
}

function updateField(fieldId: string, field: FieldSpec): GhResult<void> {
  const result = ghGraphql<{
    updateProjectV2Field: { projectV2Field: { id: string } };
  }>(
    `mutation { updateProjectV2Field(input: { fieldId: ${JSON.stringify(fieldId)}, ${updateFieldInputLiteral(field)} }) { projectV2Field { ... on ProjectV2FieldCommon { id } } } }`,
  );
  return result.ok ? ghOk(undefined) : result;
}

/** Every field on one project, by name, so the reconcile below can tell create from update. */
function fieldIdsByName(projectId: string): GhResult<Map<string, string>> {
  const result = ghGraphql<{
    node: { fields: { nodes: { id?: string; name?: string }[] } };
  }>(
    `query { node(id: ${JSON.stringify(projectId)}) { ... on ProjectV2 { fields(first: 50) { nodes { ... on ProjectV2FieldCommon { id name } } } } } }`,
  );
  if (!result.ok) return result;
  const byName = new Map<string, string>();
  for (const node of result.value.node.fields.nodes) {
    if (node.id && node.name) byName.set(node.name, node.id);
  }
  return ghOk(byName);
}

/**
 * Brings one project's fields in line with `fields`, creating what is absent and updating what
 * is already there.
 *
 * A brand-new project is not blank. GitHub seeds every project with a `Status` single select
 * whose options are Todo, In Progress, and Done, so creating our own `Status` fails with "Name
 * has already been taken". The decisions board needs Accepted and Superseded on that same
 * field, which is an update rather than a create.
 *
 * Only single selects and iterations are updated. A TEXT, NUMBER, or DATE field carries no
 * configuration a rerun could usefully change, and rewriting one would churn its name for no
 * reason.
 */
function reconcileFields(
  projectId: string,
  fields: readonly FieldSpec[],
): GhResult<void> {
  const existing = fieldIdsByName(projectId);
  if (!existing.ok) return existing;

  for (const field of fields) {
    const fieldId = existing.value.get(field.name);
    if (fieldId === undefined) {
      const created = createField(projectId, field);
      if (!created.ok) return created;
      continue;
    }
    if (field.dataType !== 'SINGLE_SELECT' && field.dataType !== 'ITERATION') {
      continue;
    }
    const updated = updateField(fieldId, field);
    if (!updated.ok) return updated;
  }
  return ghOk(undefined);
}

function failStep(message: string): never {
  console.error(`GitHub Projects sync failed: ${message}`);
  process.exit(1);
}

interface ResolvedProject {
  number: number;
  id: string;
}

/**
 * The one saved view a freshly created board opens with, so it shows a useful layout instead
 * of a default table of every field. Named after the ledger, matching the board title's second
 * word.
 *
 * Existing boards are never touched. Reconciling a view on every run would need to tell "never
 * configured" apart from "the user rearranged it deliberately", and there is no reliable signal
 * for that, so `bootstrap` only configures the view of a board it creates.
 */
const VIEW_SPECS: Record<
  LedgerKind,
  {
    name: string;
    layout: 'BOARD_LAYOUT' | 'TABLE_LAYOUT';
    visibleFieldNames: readonly string[];
  }
> = {
  backlog: {
    name: 'Backlog',
    layout: 'BOARD_LAYOUT',
    visibleFieldNames: [
      'Title',
      'Status',
      'Linked pull requests',
      'Sub-issues progress',
      'Area',
    ],
  },
  decisions: {
    name: 'Decisions',
    layout: 'TABLE_LAYOUT',
    visibleFieldNames: [
      'Title',
      'Supersedes',
      'Chat',
      'Superseded by',
      'Scope',
      'Area',
    ],
  },
};

interface DefaultViewResponse {
  node: { views: { nodes: { id: string; number: number }[] } } | null;
}

/**
 * A new project arrives with one default view at number 1, named `View 1`. That is the view
 * every board opens to, so configuring it means updating that view rather than creating a
 * second one.
 */
function fetchDefaultViewId(projectId: string): GhResult<string> {
  const query = `query { node(id: ${JSON.stringify(projectId)}) { ... on ProjectV2 { views(first: 1) { nodes { id number } } } } }`;
  const result = ghGraphql<DefaultViewResponse>(query);
  if (!result.ok) return result;
  const view = result.value.node?.views.nodes[0];
  return view ? ghOk(view.id) : ghErr('project has no default view');
}

function updateViewMutation(
  viewId: string,
  spec: (typeof VIEW_SPECS)[LedgerKind],
  visibleFieldIds: readonly string[],
): GhResult<void> {
  const idsLiteral = visibleFieldIds.map((id) => JSON.stringify(id)).join(', ');
  const query = `mutation { updateProjectV2View(input: { viewId: ${JSON.stringify(viewId)}, name: ${JSON.stringify(spec.name)}, layout: ${spec.layout}, configuration: { visibleFieldIds: [${idsLiteral}] } }) { projectV2View { id } } }`;
  const result = ghGraphql<{
    updateProjectV2View: { projectV2View: { id: string } };
  }>(query);
  return result.ok ? ghOk(undefined) : result;
}

/**
 * Configures the default view of a board `bootstrap` just created. A field the board does not
 * have is skipped rather than failing the run, since `groupByFields` and `sortByFields` are not
 * settable and every other field named here is expected to exist by the time this runs.
 */
function configureCreatedView(
  projectId: string,
  kind: LedgerKind,
): GhResult<void> {
  const spec = VIEW_SPECS[kind];
  const fieldIds = fieldIdsByName(projectId);
  if (!fieldIds.ok) return fieldIds;

  const visibleFieldIds = spec.visibleFieldNames
    .map((name) => fieldIds.value.get(name))
    .filter((id): id is string => id !== undefined);

  const defaultView = fetchDefaultViewId(projectId);
  if (!defaultView.ok) return defaultView;

  return updateViewMutation(defaultView.value, spec, visibleFieldIds);
}

function executeStep(
  step: BootstrapStep,
  ownerId: string,
  repositoryId: string,
): ResolvedProject {
  // The full field set, not the step's `missingFields`. A field the plan counts as present may
  // still carry the wrong configuration: GitHub's seeded `Status` offers Todo, In Progress,
  // and Done on every new project, and the decisions board needs Accepted and Superseded on
  // that same field. `reconcileFields` decides create versus update per field.
  const wanted = fieldsFor(step.kind);

  if (step.action === 'create') {
    const created = createProject(ownerId, step.title);
    if (!created.ok) failStep(created.message);
    const fields = reconcileFields(created.value.id, wanted);
    if (!fields.ok) failStep(fields.message);
    const link = linkProjectToRepository(created.value.id, repositoryId);
    if (!link.ok) failStep(link.message);
    // Cosmetic: the board and its fields are what matters, so a view that fails to configure
    // is reported and the run carries on rather than failing bootstrap outright.
    const view = configureCreatedView(created.value.id, step.kind);
    if (!view.ok) {
      console.error(`Could not configure the default view: ${view.message}`);
    }
    return created.value;
  }

  const fields = reconcileFields(step.id, wanted);
  if (!fields.ok) failStep(fields.message);
  const link = linkProjectToRepository(step.id, repositoryId);
  if (!link.ok) failStep(link.message);
  return { number: step.number, id: step.id };
}

function writeEnableToken(resolved: Record<string, ResolvedProject>): void {
  const path = resolve(LEDGER_DIRECTORY, ENABLE_TOKEN_BASENAME);
  mkdirSync(LEDGER_DIRECTORY, { recursive: true });
  writeFileSync(path, `${JSON.stringify(resolved, null, 2)}\n`);
  console.log(`Wrote ${path}`);
}

function runBootstrap(dryRun: boolean): void {
  const { owner, repo } = preflight();
  checkGate('bootstrap', owner, repo);

  const ownerProjects = fetchOwnerProjects(owner);
  if (!ownerProjects.ok) failStep(ownerProjects.message);
  const repositoryId = fetchRepositoryId(owner, repo);
  if (!repositoryId.ok) failStep(repositoryId.message);

  const steps = planBootstrap(repo, ownerProjects.value.projects);

  if (dryRun) {
    if (planIsNoop(steps)) {
      console.log(
        'Nothing to do: every project already exists with every field.',
      );
      return;
    }
    for (const step of steps) console.log(describeStep(step));
    return;
  }

  const resolved: Record<string, ResolvedProject> = {};
  for (const step of steps) {
    console.log(describeStep(step));
    resolved[projectKey(step.kind)] = executeStep(
      step,
      ownerProjects.value.ownerId,
      repositoryId.value,
    );
  }
  writeEnableToken(resolved);
}

function readEnableToken(): Record<string, ResolvedProject> | null {
  const path = resolve(LEDGER_DIRECTORY, ENABLE_TOKEN_BASENAME);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as Record<
    string,
    ResolvedProject
  >;
}

function backlogLedgerPath(): string {
  return ledgerPath(REPO_ROOT, 'backlog', CONFIG.ledgers?.dir);
}

function decisionsLedgerPath(): string {
  return ledgerPath(REPO_ROOT, 'decisions', CONFIG.ledgers?.dir);
}

/**
 * Every record from one ledger, with its body decoded.
 *
 * The ledgers store `content` gzipped and base64'd to stay compact. Everything downstream of
 * this treats `content` as the real body, so the decode belongs here at the read boundary rather
 * than at each of the places that eventually writes it to GitHub. Skipping it published base64
 * into live issue bodies.
 *
 * A record whose content will not decode keeps its raw value rather than failing the run. One
 * unreadable line must not stop the other entries from syncing.
 */
function readDecodedLog(path: string): LedgerRecord[] {
  return readLog<LedgerRecord>(path).map((record) => {
    if (record.content === undefined) return record;
    try {
      return { ...record, content: decodeBody(record.content) };
    } catch {
      return record;
    }
  });
}

/**
 * The ops a push would send, from the queue merged with the index.
 *
 * The index is what lets an operation land on an entry that already left the queue: a supersede
 * needs the target's draft item id, an amend needs the same, and a close needs the issue number.
 * Without it, emptying the queue would silently make every synced entry uneditable.
 */
function readPushQueue(): PushOp[] {
  return buildPushQueue(
    readDecodedLog(backlogLedgerPath()),
    readDecodedLog(decisionsLedgerPath()),
    loadIndex(LEDGER_DIRECTORY, 'backlog')?.entries ?? [],
    loadIndex(LEDGER_DIRECTORY, 'decisions')?.entries ?? [],
  );
}

/**
 * `--under` on a `decide` record, which {@link LedgerRecord} carries no field for because
 * nothing else in this package reads it. Backfill is the one place that does.
 */
function recordUnder(record: LedgerRecord): string | null {
  return (record as { under?: string }).under ?? null;
}

/**
 * Every entry the local ledger knows, folded the same way {@link foldBacklog} and
 * {@link foldDecisions} fold a push queue: a birth record starts the entry, and `file`, `title`,
 * and `scope` take the last value any later record set.
 *
 * A backlog entry's birth action is `add`. A decision's is `decide` or `supersede`, since a
 * superseding decision is itself a new entry on the board.
 */
function localEntriesFromLedger(
  kind: LedgerKind,
  records: readonly LedgerRecord[],
): LocalEntry[] {
  const birthActions = kind === 'backlog' ? ['add'] : ['decide', 'supersede'];
  const entries = new Map<string, LocalEntry>();

  for (const record of records) {
    if (birthActions.includes(record.action)) {
      entries.set(record.id, {
        id: record.id,
        title: record.title ?? '',
        surface: record.file ?? '',
        date: record.ts.slice(0, 10),
        chat: record.chat ?? null,
        scope: record.scope ?? [],
        under: kind === 'decisions' ? recordUnder(record) : null,
      });
      continue;
    }
    const entry = entries.get(record.id);
    if (!entry) continue;
    if (record.file !== undefined) entry.surface = record.file;
    if (record.title !== undefined) entry.title = record.title;
    if (record.scope !== undefined) entry.scope = record.scope;
  }

  return Array.from(entries.values());
}

interface LedgerCompaction {
  kind: LedgerKind;
  path: string;
  before: LedgerRecord[];
  result: CompactionResult;
}

/**
 * What compaction would do to both ledgers, and whether applying it is safe.
 *
 * Reads the ledgers RAW, which is the one place here that does not go through
 * {@link readDecodedLog}. Compaction rewrites the file, and the ledgers store `content` gzipped
 * and base64'd, so writing decoded records back would corrupt every body it touched. Nothing in
 * the fold depends on what a body says, only on whether one changed, so raw records classify
 * identically.
 *
 * `unsafe` is the guard that makes a destructive rewrite acceptable: the queue built from the
 * compacted records has to equal the one built from the originals, op for op. Compaction that
 * turned finished work back into pending work would duplicate board items, and compaction that
 * hid pending work would strand it forever with no error.
 */
function planCompaction(): {
  ledgers: LedgerCompaction[];
  unsafe: string | null;
} {
  const backlogPath = backlogLedgerPath();
  const decisionsPath = decisionsLedgerPath();
  const backlogBefore = readLog<LedgerRecord>(backlogPath);
  const decisionsBefore = readLog<LedgerRecord>(decisionsPath);

  const backlogIndex = loadIndex(LEDGER_DIRECTORY, 'backlog')?.entries ?? [];
  const decisionsIndex =
    loadIndex(LEDGER_DIRECTORY, 'decisions')?.entries ?? [];

  const queueBefore = buildPushQueue(
    backlogBefore,
    decisionsBefore,
    backlogIndex,
    decisionsIndex,
  );
  const pending = pendingEntryIds(queueBefore);
  const backlog = compactBacklog(backlogBefore, pending, backlogIndex);
  const decisions = compactDecisions(decisionsBefore, pending, decisionsIndex);
  const queueAfter = buildPushQueue(
    backlog.records,
    decisions.records,
    backlogIndex,
    decisionsIndex,
  );

  return {
    ledgers: [
      {
        kind: 'backlog',
        path: backlogPath,
        before: backlogBefore,
        result: backlog,
      },
      {
        kind: 'decisions',
        path: decisionsPath,
        before: decisionsBefore,
        result: decisions,
      },
    ],
    unsafe:
      JSON.stringify(queueAfter) === JSON.stringify(queueBefore)
        ? null
        : `it would change the push queue, from ${queueBefore.length} operations to ${queueAfter.length}`,
  };
}

/**
 * Replaces a ledger with its compacted records.
 *
 * No backup is kept beside it. A single-generation backup would be overwritten by the next
 * compaction before anyone could read it, so it would promise a recovery it could never deliver.
 * The temp-plus-rename below is the real safety: an interruption at any point leaves either the
 * original or a complete replacement and never a half-written ledger.
 */
function writeCompactedLedger(
  path: string,
  records: readonly LedgerRecord[],
): void {
  const temporary = `${path}.compacting`;
  writeFileSync(temporary, serializeLedger(records));
  renameSync(temporary, path);
}

function runCompaction(dryRun: boolean): void {
  const { ledgers, unsafe } = planCompaction();
  if (unsafe) {
    console.error(`Skipping ledger compaction, because ${unsafe}.`);
    console.error('Both ledgers are unchanged. Please report this.');
    return;
  }

  const changed = ledgers.filter(
    (ledger) => !compactionIsNoop(ledger.before, ledger.result),
  );
  if (changed.length === 0) {
    console.log('Ledgers are already compact.');
    return;
  }

  for (const ledger of changed) {
    console.log(
      describeCompaction(ledger.kind, ledger.before.length, ledger.result),
    );
    for (const entry of ledger.result.dropped) {
      console.log(`  dropped ${entry.id}  ${entry.title}`);
    }
    if (!dryRun) writeCompactedLedger(ledger.path, ledger.result.records);
  }
}

function printGateState(): void {
  const verdict = evaluateGate(
    readGateInputs(LEDGER_DIRECTORY, autoSyncSetting()),
  );
  console.log(
    verdict.allowed ? 'sync: allowed' : `sync: blocked (${verdict.reason})`,
  );
  if (!verdict.allowed) console.log(verdict.message);
}

function printPendingCounts(): void {
  const summary = summarizeQueue(readPushQueue());
  console.log(
    `pending: backlog ${summary.backlogPending}, decisions ${summary.decisionsPending}`,
  );
}

function runStatus(): void {
  const { repo } = preflight();
  printGateState();
  printPendingCounts();

  const resolved = readEnableToken();
  if (!resolved) {
    console.log('No local project mapping yet. Run `bootstrap` first.');
    return;
  }

  for (const kind of LEDGER_KINDS) {
    const project = resolved[projectKey(kind)];
    console.log(
      project
        ? `${repo} ${kind}: #${project.number}`
        : `${repo} ${kind}: not bootstrapped`,
    );
  }
}

/**
 * The board an op belongs on.
 *
 * One per kind, so the surface plays no part in choosing it. The surface becomes the item's `Area`
 * value instead, which is what scopes an item within the single board.
 */
function resolveBoard(
  kind: LedgerKind,
  resolved: Record<string, ResolvedProject>,
): ResolvedProject | null {
  return resolved[projectKey(kind)] ?? null;
}

function fetchIssueNodeId(
  owner: string,
  repo: string,
  number: number,
): GhResult<string> {
  const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { issue(number: ${number}) { id } } }`;
  const result = ghGraphql<{
    repository: { issue: { id: string } | null } | null;
  }>(query);
  if (!result.ok) return result;
  const issue = result.value.repository?.issue;
  return issue
    ? ghOk(issue.id)
    : ghErr(`GitHub has no issue #${number} in ${owner}/${repo}`);
}

/** An issue's node id and current body, for the adopt path's marker check. */
function fetchIssueBody(
  owner: string,
  repo: string,
  number: number,
): GhResult<{ id: string; body: string }> {
  const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { issue(number: ${number}) { id body } } }`;
  const result = ghGraphql<{
    repository: { issue: { id: string; body: string } | null } | null;
  }>(query);
  if (!result.ok) return result;
  const issue = result.value.repository?.issue;
  return issue
    ? ghOk(issue)
    : ghErr(`GitHub has no issue #${number} in ${owner}/${repo}`);
}

function updateIssueBodyMutation(
  issueId: string,
  body: string,
): GhResult<void> {
  const query = `mutation { updateIssue(input: { id: ${JSON.stringify(issueId)}, body: ${JSON.stringify(body)} }) { issue { id } } }`;
  const result = ghGraphql<{ updateIssue: { issue: { id: string } } }>(query);
  return result.ok ? ghOk(undefined) : result;
}

function createIssueMutation(
  repositoryId: string,
  title: string,
  body: string,
): GhResult<{ id: string; number: number }> {
  const query = `mutation { createIssue(input: { repositoryId: ${JSON.stringify(repositoryId)}, title: ${JSON.stringify(title)}, body: ${JSON.stringify(body)} }) { issue { id number } } }`;
  const result = ghGraphql<{
    createIssue: { issue: { id: string; number: number } };
  }>(query);
  return result.ok ? ghOk(result.value.createIssue.issue) : result;
}

function updateIssueMutation(
  issueId: string,
  title: string,
  body: string,
): GhResult<void> {
  const query = `mutation { updateIssue(input: { id: ${JSON.stringify(issueId)}, title: ${JSON.stringify(title)}, body: ${JSON.stringify(body)} }) { issue { id } } }`;
  const result = ghGraphql<{ updateIssue: { issue: { id: string } } }>(query);
  return result.ok ? ghOk(undefined) : result;
}

function addCommentMutation(subjectId: string, body: string): GhResult<void> {
  const query = `mutation { addComment(input: { subjectId: ${JSON.stringify(subjectId)}, body: ${JSON.stringify(body)} }) { subject { id } } }`;
  const result = ghGraphql<{ addComment: { subject: { id: string } } }>(query);
  return result.ok ? ghOk(undefined) : result;
}

function closeIssueMutation(issueId: string): GhResult<void> {
  const query = `mutation { closeIssue(input: { issueId: ${JSON.stringify(issueId)} }) { issue { id } } }`;
  const result = ghGraphql<{ closeIssue: { issue: { id: string } } }>(query);
  return result.ok ? ghOk(undefined) : result;
}

/**
 * Adds an issue or draft issue to a project. Idempotent: GitHub returns the existing item
 * rather than a duplicate when the content is already on the board, which is what lets
 * `update-issue`, `close-issue`, and `report-move` resolve an item id without tracking one.
 */
function addIssueToProject(
  projectId: string,
  contentId: string,
): GhResult<string> {
  const query = `mutation { addProjectV2ItemById(input: { projectId: ${JSON.stringify(projectId)}, contentId: ${JSON.stringify(contentId)} }) { item { id } } }`;
  const result = ghGraphql<{
    addProjectV2ItemById: { item: { id: string } };
  }>(query);
  return result.ok ? ghOk(result.value.addProjectV2ItemById.item.id) : result;
}

function addDraftIssueMutation(
  projectId: string,
  title: string,
  body: string,
): GhResult<string> {
  const query = `mutation { addProjectV2DraftIssue(input: { projectId: ${JSON.stringify(projectId)}, title: ${JSON.stringify(title)}, body: ${JSON.stringify(body)} }) { projectItem { id } } }`;
  const result = ghGraphql<{
    addProjectV2DraftIssue: { projectItem: { id: string } };
  }>(query);
  return result.ok
    ? ghOk(result.value.addProjectV2DraftIssue.projectItem.id)
    : result;
}

function updateDraftIssueMutation(
  draftIssueId: string,
  body: string,
): GhResult<void> {
  const query = `mutation { updateProjectV2DraftIssue(input: { draftIssueId: ${JSON.stringify(draftIssueId)}, body: ${JSON.stringify(body)} }) { draftIssue { id } } }`;
  const result = ghGraphql<{
    updateProjectV2DraftIssue: { draftIssue: { id: string } };
  }>(query);
  return result.ok ? ghOk(undefined) : result;
}

/**
 * The draft issue's own content id, from the project item id a `synced` record carries.
 *
 * `updateProjectV2DraftIssue` takes the draft's content id, not the project item id, so
 * `update-draft` has to look this up rather than reuse `op.itemId` directly.
 */
function fetchDraftContentId(itemId: string): GhResult<string> {
  const query = `query { node(id: ${JSON.stringify(itemId)}) { ... on ProjectV2Item { content { ... on DraftIssue { id } } } } }`;
  const result = ghGraphql<{
    node: { content: { id: string } | null } | null;
  }>(query);
  if (!result.ok) return result;
  const id = result.value.node?.content?.id;
  return id ? ghOk(id) : ghErr(`project item ${itemId} is not a draft issue`);
}

function updateFieldValueMutation(
  projectId: string,
  itemId: string,
  fieldId: string,
  valueLiteral: string,
): GhResult<void> {
  const query = `mutation { updateProjectV2ItemFieldValue(input: { projectId: ${JSON.stringify(projectId)}, itemId: ${JSON.stringify(itemId)}, fieldId: ${JSON.stringify(fieldId)}, value: ${valueLiteral} }) { projectV2Item { id } } }`;
  const result = ghGraphql<{
    updateProjectV2ItemFieldValue: { projectV2Item: { id: string } };
  }>(query);
  return result.ok ? ghOk(undefined) : result;
}

interface ProjectFieldInfo {
  id: string;
  options: Map<string, string>;
}

const projectFieldCache = new Map<string, Map<string, ProjectFieldInfo>>();

function fetchProjectFields(
  projectId: string,
): GhResult<Map<string, ProjectFieldInfo>> {
  const query = `query { node(id: ${JSON.stringify(projectId)}) { ... on ProjectV2 { fields(first: 50) { nodes {
    ... on ProjectV2FieldCommon { id name }
    ... on ProjectV2SingleSelectField { options { id name } }
  } } } } }`;
  const result = ghGraphql<{
    node: {
      fields: {
        nodes: {
          id?: string;
          name?: string;
          options?: { id: string; name: string }[];
        }[];
      };
    };
  }>(query);
  if (!result.ok) return result;

  const byName = new Map<string, ProjectFieldInfo>();
  for (const node of result.value.node.fields.nodes) {
    if (!node.id || !node.name) continue;
    const options = new Map<string, string>();
    for (const option of node.options ?? [])
      options.set(option.name, option.id);
    byName.set(node.name, { id: node.id, options });
  }
  return ghOk(byName);
}

/** Every field on `projectId`, by name, fetched once per project per run. */
function projectFields(
  projectId: string,
): GhResult<Map<string, ProjectFieldInfo>> {
  const cached = projectFieldCache.get(projectId);
  if (cached) return ghOk(cached);

  const fetched = fetchProjectFields(projectId);
  if (fetched.ok) projectFieldCache.set(projectId, fetched.value);
  return fetched;
}

const BOARD_ITEMS_PAGE_SIZE = 100;

interface BoardItemsPage {
  nodes: BoardItem[];
  hasNextPage: boolean;
  endCursor: string | null;
}

function fetchBoardItemsPage(
  projectId: string,
  cursor: string | null,
): GhResult<BoardItemsPage> {
  const after = cursor ? `, after: ${JSON.stringify(cursor)}` : '';
  const query = `query { node(id: ${JSON.stringify(projectId)}) { ... on ProjectV2 { items(first: ${BOARD_ITEMS_PAGE_SIZE}${after}) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      content {
        __typename
        ... on Issue { number title body state }
        ... on DraftIssue { title body }
      }
      fieldValues(first: 20) { nodes {
        __typename
        ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
        ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } }
        ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
        ... on ProjectV2ItemFieldNumberValue { field { ... on ProjectV2FieldCommon { name } } }
        ... on ProjectV2ItemFieldIterationValue { field { ... on ProjectV2FieldCommon { name } } }
        ... on ProjectV2ItemFieldLabelValue { field { ... on ProjectV2FieldCommon { name } } }
        ... on ProjectV2ItemFieldMilestoneValue { field { ... on ProjectV2FieldCommon { name } } }
        ... on ProjectV2ItemFieldMultiSelectValue { field { ... on ProjectV2FieldCommon { name } } }
        ... on ProjectV2ItemFieldPullRequestValue { field { ... on ProjectV2FieldCommon { name } } }
        ... on ProjectV2ItemFieldRepositoryValue { field { ... on ProjectV2FieldCommon { name } } }
        ... on ProjectV2ItemFieldReviewerValue { field { ... on ProjectV2FieldCommon { name } } }
        ... on ProjectV2ItemFieldUserValue { field { ... on ProjectV2FieldCommon { name } } }
        ... on ProjectV2ItemIssueFieldValue { field { ... on ProjectV2FieldCommon { name } } }
      } }
    }
  } } } }`;

  const result = ghGraphql<{
    node: {
      items: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: BoardItem[];
      };
    } | null;
  }>(query);
  if (!result.ok) return result;
  const items = result.value.node?.items;
  if (!items) return ghErr(`GitHub has no project ${projectId}`);
  return ghOk({
    nodes: items.nodes,
    hasNextPage: items.pageInfo.hasNextPage,
    endCursor: items.pageInfo.endCursor,
  });
}

/** Every item on `projectId`'s board, paged until GitHub reports no page remains. */
function fetchBoardItems(projectId: string): GhResult<BoardItem[]> {
  const all: BoardItem[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = fetchBoardItemsPage(projectId, cursor);
    if (!page.ok) return page;
    all.push(...page.value.nodes);
    if (!page.value.hasNextPage) break;
    cursor = page.value.endCursor;
  }
  return ghOk(all);
}

/**
 * Sets every field `values` names on `itemId`, resolving each field and, for a single select,
 * its option, by name against `project`. A field or option name the board does not carry is
 * reported rather than thrown, since it is a per-op failure and not a reason to crash the run.
 */
function setFieldValues(
  project: ResolvedProject,
  itemId: string,
  values: readonly FieldValue[],
): GhResult<void> {
  if (values.length === 0) return ghOk(undefined);

  const fields = projectFields(project.id);
  if (!fields.ok) return fields;

  for (const value of values) {
    const field = fields.value.get(value.field);
    if (!field) {
      return ghErr(`project has no field named "${value.field}"`);
    }
    let optionId: string | undefined;
    if (value.kind === 'single-select') {
      optionId = field.options.get(value.option);
      if (!optionId) {
        return ghErr(
          `field "${value.field}" has no option named "${value.option}"`,
        );
      }
    }
    const set = updateFieldValueMutation(
      project.id,
      itemId,
      field.id,
      fieldValueLiteral(value, optionId),
    );
    if (!set.ok) return set;
  }
  return ghOk(undefined);
}

/** What one landed push op reports for the `synced` record the executor appends. */
interface SyncResult {
  issue?: number;
  itemId?: string;
}

interface PushContext {
  owner: string;
  repo: string;
  repositoryId: string;
  /** Draft item ids created earlier in this run, by entry id, for a same-run `mark-superseded`. */
  createdDraftItems: Map<string, string>;
}

type CreateIssueOp = Extract<PushOp, { op: 'create-issue' }>;
type AttachIssueOp = Extract<PushOp, { op: 'attach-issue' }>;
type UpdateIssueOp = Extract<PushOp, { op: 'update-issue' }>;
type CloseIssueOp = Extract<PushOp, { op: 'close-issue' }>;
type CreateDraftOp = Extract<PushOp, { op: 'create-draft' }>;
type UpdateDraftOp = Extract<PushOp, { op: 'update-draft' }>;
type MarkSupersededOp = Extract<PushOp, { op: 'mark-superseded' }>;
type MutatingOp = Exclude<PushOp, { op: 'report-move' }>;

function handleCreateIssue(
  op: CreateIssueOp,
  project: ResolvedProject,
  ctx: PushContext,
): GhResult<SyncResult> {
  const created = createIssueMutation(
    ctx.repositoryId,
    op.title,
    appendMarker(op.body, op.entryId),
  );
  if (!created.ok) return created;
  const added = addIssueToProject(project.id, created.value.id);
  if (!added.ok) return added;
  const fields = setFieldValues(project, added.value, fieldValuesFor(op));
  if (!fields.ok) return fields;
  return ghOk({ issue: created.value.number });
}

/**
 * Adds a reporter's issue to the board and marks it as adopted.
 *
 * `markIssueAdopted` is the only write the adopt path makes to an issue somebody else
 * reported and wrote, and it is append-only: it appends the entry marker to the issue's
 * body and leaves the rest of the body and the title untouched.
 */
function handleAttachIssue(
  op: AttachIssueOp,
  project: ResolvedProject,
  ctx: PushContext,
): GhResult<SyncResult> {
  const issue = fetchIssueBody(ctx.owner, ctx.repo, op.issue);
  if (!issue.ok) return issue;
  const marked = markIssueAdopted(issue.value, op.entryId);
  if (!marked.ok) return marked;
  const added = addIssueToProject(project.id, issue.value.id);
  if (!added.ok) return added;
  const fields = setFieldValues(project, added.value, fieldValuesFor(op));
  if (!fields.ok) return fields;
  return ghOk({ issue: op.issue });
}

/**
 * Appends `entryId`'s marker to `issue.body` and writes it back, skipping the API call when
 * `appendMarker` reports the issue already carries a marker. A write failure here is returned
 * as a `GhErr` rather than swallowed, since a missing marker lets a later push adopt the same
 * issue again and create a duplicate entry.
 */
function markIssueAdopted(
  issue: { id: string; body: string },
  entryId: string,
): GhResult<void> {
  const marked = appendMarker(issue.body, entryId);
  if (marked === issue.body) return ghOk(undefined);
  return updateIssueBodyMutation(issue.id, marked);
}

function handleUpdateIssue(
  op: UpdateIssueOp,
  project: ResolvedProject,
  ctx: PushContext,
): GhResult<SyncResult> {
  const issueId = fetchIssueNodeId(ctx.owner, ctx.repo, op.issue);
  if (!issueId.ok) return issueId;
  const updated = updateIssueMutation(issueId.value, op.title, op.body);
  if (!updated.ok) return updated;
  const added = addIssueToProject(project.id, issueId.value);
  if (!added.ok) return added;
  const fields = setFieldValues(project, added.value, fieldValuesFor(op));
  if (!fields.ok) return fields;
  return ghOk({ issue: op.issue });
}

function handleCloseIssue(
  op: CloseIssueOp,
  project: ResolvedProject,
  ctx: PushContext,
): GhResult<SyncResult> {
  const issueId = fetchIssueNodeId(ctx.owner, ctx.repo, op.issue);
  if (!issueId.ok) return issueId;
  const commented = addCommentMutation(issueId.value, op.reason);
  if (!commented.ok) return commented;
  const added = addIssueToProject(project.id, issueId.value);
  if (!added.ok) return added;
  const fields = setFieldValues(project, added.value, fieldValuesFor(op));
  if (!fields.ok) return fields;
  const closed = closeIssueMutation(issueId.value);
  if (!closed.ok) return closed;
  return ghOk({ issue: op.issue });
}

function handleCreateDraft(
  op: CreateDraftOp,
  project: ResolvedProject,
  ctx: PushContext,
): GhResult<SyncResult> {
  // The marker is what lets `pull` recognise this draft as ours later. Creating without one is
  // how all 41 existing drafts ended up unmappable: the issue paths appended it and this one did
  // not, so a decision reached the board and then vanished from every projection of it.
  const created = addDraftIssueMutation(
    project.id,
    op.title,
    appendMarker(op.body, op.entryId),
  );
  if (!created.ok) return created;
  const fields = setFieldValues(project, created.value, fieldValuesFor(op));
  if (!fields.ok) return fields;
  ctx.createdDraftItems.set(op.entryId, created.value);
  return ghOk({ itemId: created.value });
}

function handleUpdateDraft(
  op: UpdateDraftOp,
  project: ResolvedProject,
): GhResult<SyncResult> {
  const contentId = fetchDraftContentId(op.itemId);
  if (!contentId.ok) return contentId;
  const updated = updateDraftIssueMutation(contentId.value, op.body);
  if (!updated.ok) return updated;
  const fields = setFieldValues(project, op.itemId, fieldValuesFor(op));
  if (!fields.ok) return fields;
  return ghOk({ itemId: op.itemId });
}

function handleMarkSuperseded(
  op: MarkSupersededOp,
  project: ResolvedProject,
  ctx: PushContext,
): GhResult<SyncResult> {
  const itemId = resolveMarkSupersededItemId(op, ctx.createdDraftItems);
  if (!itemId.ok) return itemId;
  const fields = setFieldValues(project, itemId.value, fieldValuesFor(op));
  if (!fields.ok) return fields;
  return ghOk({ itemId: itemId.value });
}

function runMutatingOp(
  op: MutatingOp,
  project: ResolvedProject,
  ctx: PushContext,
): GhResult<SyncResult> {
  switch (op.op) {
    case 'create-issue':
      return handleCreateIssue(op, project, ctx);
    case 'attach-issue':
      return handleAttachIssue(op, project, ctx);
    case 'update-issue':
      return handleUpdateIssue(op, project, ctx);
    case 'close-issue':
      return handleCloseIssue(op, project, ctx);
    case 'create-draft':
      return handleCreateDraft(op, project, ctx);
    case 'update-draft':
      return handleUpdateDraft(op, project);
    case 'mark-superseded':
      return handleMarkSuperseded(op, project, ctx);
  }
}

type OpOutcome =
  | { kind: 'synced'; result: SyncResult }
  | { kind: 'skipped' }
  | { kind: 'failed'; status: number | null; message: string };

function toOutcome(result: GhResult<SyncResult>): OpOutcome {
  return result.ok
    ? { kind: 'synced', result: result.value }
    : { kind: 'failed', status: result.status, message: result.message };
}

/**
 * Re-files an entry that moved to another surface.
 *
 * With one board per ledger a move never changes which board an item sits on, so this sets the
 * item's `Area` and nothing else.
 *
 * A backlog item is found by its issue. A decision draft has no issue, so it is found by the item
 * id the index recorded, which is why this op is one of the reasons push reads the index at all.
 */
function executeReportMove(
  op: Extract<PushOp, { op: 'report-move' }>,
  resolved: Record<string, ResolvedProject>,
  ctx: PushContext,
): OpOutcome {
  const project = resolveBoard(op.kind, resolved);
  if (!project) {
    return {
      kind: 'failed',
      status: null,
      message: `no board configured for ${op.kind}`,
    };
  }

  const area: FieldValue[] = [
    { field: 'Area', kind: 'text', value: areaForSurface(op.toSurface) },
  ];

  if (op.issue !== null) {
    const issueId = fetchIssueNodeId(ctx.owner, ctx.repo, op.issue);
    if (!issueId.ok) return toOutcome(issueId);
    const added = addIssueToProject(project.id, issueId.value);
    if (!added.ok) return toOutcome(added);
    const fields = setFieldValues(project, added.value, area);
    if (!fields.ok) return toOutcome(fields);
    return { kind: 'synced', result: { issue: op.issue } };
  }

  const itemId = op.itemId ?? ctx.createdDraftItems.get(op.entryId);
  if (!itemId) {
    console.log(
      `${op.entryId} moved to ${op.toSurface}, but it is not on the board yet, so there is nothing to re-file.`,
    );
    return { kind: 'skipped' };
  }
  const fields = setFieldValues(project, itemId, area);
  if (!fields.ok) return toOutcome(fields);
  return { kind: 'synced', result: { itemId } };
}

function executeOp(
  op: PushOp,
  resolved: Record<string, ResolvedProject>,
  ctx: PushContext,
): OpOutcome {
  if (op.op === 'report-move') return executeReportMove(op, resolved, ctx);

  const project = resolveBoard(op.kind, resolved);
  if (!project) {
    return {
      kind: 'failed',
      status: null,
      message: `no board configured for surface "${op.surface}"`,
    };
  }
  return toOutcome(runMutatingOp(op, project, ctx));
}

function executePushQueue(
  queue: readonly PushOp[],
  resolved: Record<string, ResolvedProject>,
  owner: string,
  repo: string,
): void {
  const repositoryId = fetchRepositoryId(owner, repo);
  if (!repositoryId.ok) failStep(repositoryId.message);
  const ctx: PushContext = {
    owner,
    repo,
    repositoryId: repositoryId.value,
    createdDraftItems: new Map(),
  };
  const backlogLog = backlogLedgerPath();
  const decisionsLog = decisionsLedgerPath();

  const failures: string[] = [];
  for (const op of queue) {
    const outcome = executeOp(op, resolved, ctx);
    if (outcome.kind === 'skipped') continue;
    if (outcome.kind === 'failed') {
      if (outcome.status === 403 || outcome.status === 404) {
        console.error(
          `GitHub Projects sync stopped: access refused (${outcome.status}). ${outcome.message}`,
        );
        process.exit(1);
      }
      failures.push(`${op.entryId} (${op.op}): ${outcome.message}`);
      continue;
    }
    const logFile = op.kind === 'backlog' ? backlogLog : decisionsLog;
    appendEvent(logFile, syncedRecord(op, outcome.result, nowIso()));
    console.log(`synced ${op.entryId} (${op.op})`);
  }

  if (failures.length > 0) {
    console.error('GitHub Projects sync finished with failures:');
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
}

function runPush(dryRun: boolean): void {
  const { owner, repo } = preflight();
  checkGate('push', owner, repo);

  const resolved = readEnableToken();
  if (!resolved) {
    console.error('No local project mapping yet. Run `bootstrap` first.');
    process.exit(1);
  }

  const queue = readPushQueue();
  if (queue.length === 0) console.log('Nothing to push.');
  else if (dryRun) for (const op of queue) console.log(describeOp(op));
  else executePushQueue(queue, resolved, owner, repo);

  // Push, then pull, then drain, and the order is load bearing. Draining before the pull would
  // remove entries the index has not learned about yet, and the drain refuses to remove anything
  // the index cannot confirm, so a stale index costs a slower drain rather than a lost entry.
  if (!dryRun) runPull(false);
  runCompaction(dryRun);
}

interface ItemContent {
  kind: 'draft' | 'issue';
  id: string;
}

/**
 * The content id and shape behind one project item, so `append-marker` knows which mutation to
 * send. A backfilled board mixes issues and draft issues on the same field set, and only the
 * item's own content answers which one a given `itemId` is.
 */
function fetchItemContentId(itemId: string): GhResult<ItemContent> {
  const query = `query { node(id: ${JSON.stringify(itemId)}) { ... on ProjectV2Item { content {
    __typename
    ... on DraftIssue { id }
    ... on Issue { id }
  } } } }`;
  const result = ghGraphql<{
    node: { content: { __typename: string; id: string } | null } | null;
  }>(query);
  if (!result.ok) return result;
  const content = result.value.node?.content;
  if (!content) return ghErr(`project item ${itemId} has no content`);
  if (content.__typename === 'DraftIssue')
    return ghOk({ kind: 'draft', id: content.id });
  if (content.__typename === 'Issue')
    return ghOk({ kind: 'issue', id: content.id });
  return ghErr(`project item ${itemId} is neither an issue nor a draft issue`);
}

function handleAppendMarker(
  op: Extract<BackfillOp, { op: 'append-marker' }>,
): GhResult<void> {
  const content = fetchItemContentId(op.itemId);
  if (!content.ok) return content;
  const marked = appendMarker(op.body, op.entryId);
  return content.value.kind === 'draft'
    ? updateDraftIssueMutation(content.value.id, marked)
    : updateIssueBodyMutation(content.value.id, marked);
}

function handleSetField(
  op: Extract<BackfillOp, { op: 'set-field' }>,
  project: ResolvedProject,
): GhResult<void> {
  const fields = projectFields(project.id);
  if (!fields.ok) return fields;
  const field = fields.value.get(op.field);
  if (!field) return ghErr(`project has no field named "${op.field}"`);
  return updateFieldValueMutation(
    project.id,
    op.itemId,
    field.id,
    fieldValueLiteral(backfillFieldValue(op.field, op.value)),
  );
}

function executeBackfillOp(
  op: BackfillOp,
  project: ResolvedProject,
): GhResult<void> {
  return op.op === 'append-marker'
    ? handleAppendMarker(op)
    : handleSetField(op, project);
}

/**
 * Backfills one board: plans against its items plus the local entries, reports what it finds,
 * and executes the plan unless `dryRun`.
 *
 * Warnings for unmatched items and ambiguous titles print even when the plan is otherwise a
 * no-op, since those are exactly the items backfill silently leaves untouched.
 */
function runBackfillForBoard(
  kind: LedgerKind,
  project: ResolvedProject,
  local: readonly LocalEntry[],
  repo: string,
  dryRun: boolean,
): void {
  const items = fetchBoardItems(project.id);
  if (!items.ok) failStep(items.message);
  const projection = projectBoardItems(kind, items.value);
  const plan = planBackfill(kind, local, [
    ...projection.entries,
    ...projection.unmarked,
  ]);

  const label = repo;

  for (const itemId of plan.unmatched) {
    console.log(
      `${label} ${kind}: warning: item ${itemId} has no matching local entry, skipped`,
    );
  }
  for (const title of plan.ambiguous) {
    console.log(
      `${label} ${kind}: warning: title "${title}" matches more than one local entry, skipped`,
    );
  }

  if (backfillIsNoop(plan)) {
    console.log(`${label} ${kind}: already current.`);
    return;
  }

  for (const op of plan.ops) {
    console.log(`${label} ${kind}: ${describeBackfillOp(op)}`);
  }
  if (dryRun) return;

  for (const op of plan.ops) {
    const outcome = executeBackfillOp(op, project);
    if (!outcome.ok) {
      failStep(`${describeBackfillOp(op)}: ${outcome.message}`);
    }
  }
}

function runBackfill(dryRun: boolean): void {
  const { owner, repo } = preflight();
  checkGate('backfill', owner, repo);

  const resolved = readEnableToken();
  if (!resolved) {
    console.error('No local project mapping yet. Run `bootstrap` first.');
    process.exit(1);
  }

  const localByKind: Record<LedgerKind, LocalEntry[]> = {
    backlog: localEntriesFromLedger(
      'backlog',
      readDecodedLog(backlogLedgerPath()),
    ),
    decisions: localEntriesFromLedger(
      'decisions',
      readDecodedLog(decisionsLedgerPath()),
    ),
  };

  for (const kind of LEDGER_KINDS) {
    const project = resolved[projectKey(kind)];
    if (!project) continue;
    runBackfillForBoard(kind, project, localByKind[kind], repo, dryRun);
  }
}

/** The board the enable token names for `kind`, as a list so `pull` reads one shape. */
function boardsForKind(
  kind: LedgerKind,
  resolved: Record<string, ResolvedProject>,
): ResolvedProject[] {
  const prefix = `${kind}:`;
  return Object.entries(resolved)
    .filter(([key]) => key === kind || key.startsWith(prefix))
    .map(([, project]) => project);
}

/**
 * Writes `index` atomically, the same temp-plus-rename `writeCompactedLedger` uses. A half
 * written index read by the `UserPromptSubmit` hook is worse than no index at all.
 */
function writeIndex(kind: LedgerKind, index: LedgerIndex): void {
  const path = resolve(LEDGER_DIRECTORY, indexBasename(kind));
  const temporary = `${path}.pulling`;
  mkdirSync(LEDGER_DIRECTORY, { recursive: true });
  writeFileSync(temporary, serializeIndex(index));
  renameSync(temporary, path);
  console.log(`Wrote ${path}`);
}

/**
 * Every entry `kind`'s boards hold, read from each board the enable token names.
 *
 * A board that no longer exists is reported and skipped rather than ending the run, since one
 * stale row must not cost the whole index. `unmarked` and `skipped` items are dropped: an
 * unmarked item is not ours, and `pull` only reads what the ledger can already recognize.
 */
function pullKind(
  kind: LedgerKind,
  resolved: Record<string, ResolvedProject>,
): LedgerIndex {
  const boards = boardsForKind(kind, resolved);
  const entries: BoardEntry[] = [];
  const projects: number[] = [];

  for (const board of boards) {
    const items = fetchBoardItems(board.id);
    if (!items.ok) {
      console.error(
        `${kind} #${board.number}: could not read this board, skipped (${items.message})`,
      );
      continue;
    }
    const projection = projectBoardItems(kind, items.value);
    entries.push(...projection.entries);
    projects.push(board.number);
  }

  return { ...emptyIndex(kind, nowIso()), projects, entries };
}

/**
 * Every board `pull` can read, by title, for a contributor with no enable token.
 *
 * Fetches the owner's projects once for the whole run and matches each (kind, target) pair by
 * the same deterministic title `bootstrap` adopts by, so a contributor with read access but no
 * token still resolves the real boards rather than guessing at them. A title that matches
 * nothing is skipped and printed, since a repo nobody has bootstrapped yet is not an error.
 * Returns a failed result when the owner's projects could not even be listed, which the caller
 * must not treat the same as an empty match, since one is a transient failure and the other is
 * not.
 */
function resolveBoardsByTitle(
  owner: string,
  repo: string,
): GhResult<Record<string, ResolvedProject>> {
  const ownerProjects = fetchOwnerProjects(owner);
  if (!ownerProjects.ok) {
    return ghErr(
      `could not list projects for ${owner}: ${ownerProjects.message}`,
    );
  }

  const resolved: Record<string, ResolvedProject> = {};
  for (const kind of LEDGER_KINDS) {
    const title = projectTitle(repo, kind);
    const match = ownerProjects.value.projects.find(
      (project) => project.title === title,
    );
    if (!match) {
      console.log(`${kind}: no board titled "${title}", skipped`);
      continue;
    }
    resolved[projectKey(kind)] = { number: match.number, id: match.id };
  }
  return ghOk(resolved);
}

/**
 * Every board `pull` should read, in the same shape {@link boardsForKind} consumes.
 *
 * The enable token is authoritative and costs no API call, so it wins whenever it exists. Only
 * when there is none, meaning nobody with maintain access has bootstrapped this repo for this
 * account to adopt, does `pull` fall back to resolving boards by title.
 */
function resolveBoardsForPull(
  owner: string,
  repo: string,
): GhResult<Record<string, ResolvedProject>> {
  const token = readEnableToken();
  return token ? ghOk(token) : resolveBoardsByTitle(owner, repo);
}

/** The ledger script that renders one kind's markdown surfaces, if that module is installed. */
const RENDERER: Record<LedgerKind, string> = {
  backlog: 'backlog-log.mjs',
  decisions: 'decision-log.mjs',
};

/**
 * Rebuilds the markdown surfaces from the freshly written index.
 *
 * The rendered `<target>.BACKLOG.md` files are how someone reads the ledger without leaving the
 * codebase, and once the queue empties the index is the only thing they can be built from. Without
 * this they would freeze at whatever the last local write left behind.
 *
 * Best effort by design. The backlog and decisions modules are optional, so a repo may have one,
 * the other, or neither, and a render failing must never fail the pull that already succeeded.
 */
function renderSurfaces(kind: LedgerKind): void {
  const script = resolve(REPO_ROOT, '.claude/scripts', RENDERER[kind]);
  if (!existsSync(script)) return;
  const result = spawnSync(process.execPath, [script, 'render'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.error(
      `${kind}: surfaces not re-rendered, the index is still current.`,
    );
  }
}

function runPull(dryRun: boolean): void {
  const { owner, repo } = preflight();
  checkReadGate();

  const resolved = resolveBoardsForPull(owner, repo);
  if (!resolved.ok) {
    console.error(`Could not resolve project boards. ${resolved.message}`);
    process.exit(1);
    return;
  }
  if (Object.keys(resolved.value).length === 0) {
    console.log(
      'No project boards were found for this repo. A maintainer runs `bootstrap` once to create them.',
    );
    return;
  }

  for (const kind of LEDGER_KINDS) {
    const index = pullKind(kind, resolved.value);
    const boardList =
      index.projects.length === 0
        ? 'no boards'
        : index.projects.map((number) => `#${number}`).join(', ');
    if (dryRun) {
      console.log(
        `${kind}: would write ${index.entries.length} entries from ${boardList}`,
      );
      continue;
    }
    console.log(`${kind}: ${index.entries.length} entries from ${boardList}`);
    writeIndex(kind, index);
    renderSurfaces(kind);
  }
}

function usage(): void {
  console.error(
    [
      'Usage:',
      '  projects-sync.mjs bootstrap [--dry-run]',
      '  projects-sync.mjs push [--dry-run]',
      '  projects-sync.mjs compact [--dry-run]',
      '  projects-sync.mjs backfill [--dry-run]',
      '  projects-sync.mjs pull [--dry-run]',
      '  projects-sync.mjs status',
      '',
      'bootstrap creates or adopts one GitHub Project per (backlog, decisions),',
      'and writes the resolved project numbers to <ledger dir>/.projects.json. That file',
      'is the local token that enables pushing entries to the board.',
      'push drains the queue of ledger entries that have not reached the board yet, then',
      'compacts.',
      'compact shrinks the local ledgers to what a push still owes the board: entries the',
      'index confirms landed are dropped, and so are entries removed before they ever',
      'landed. It runs at the end of every push, and needs no network.',
      'backfill brings an existing board up to the current field schema, by matching each',
      'board item to a local ledger entry, by marker where one exists and by title where it',
      "does not, and filling in whatever the item's fields are missing.",
      'pull reads every item off both boards and writes a local index at',
      '<ledger dir>/<kind>.index.json, which `scope` and prompt injection read instead of',
      'the boards themselves. It needs only read access on the repository, not the enable',
      'token backfill and push require.',
      '--dry-run runs every read but prints each planned step instead of executing it.',
    ].join('\n'),
  );
}

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const [action] = argv.filter((arg) => arg !== '--dry-run');

switch (action) {
  case 'bootstrap':
    runBootstrap(dryRun);
    break;

  case 'push':
    runPush(dryRun);
    break;

  // No preflight and no gate. Compaction is a local rewrite that never reaches GitHub, and the
  // gate answers who may write to the board, not who may tidy their own working copy.
  case 'compact':
    runCompaction(dryRun);
    break;

  case 'backfill':
    runBackfill(dryRun);
    break;

  case 'pull':
    runPull(dryRun);
    break;

  case 'status':
    runStatus();
    break;

  default:
    usage();
    process.exit(action ? 1 : 0);
}
