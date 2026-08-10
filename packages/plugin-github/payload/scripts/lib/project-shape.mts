/**
 * What a synced project looks like: its title, its fields, and the marker that ties a GitHub
 * issue back to the ledger entry it came from.
 *
 * Entirely pure. No `gh`, no disk. Every rule about naming and shape lives here so the bootstrap
 * and push paths cannot disagree about what they are looking for.
 */

// Core declares this, and it is re-exported so every board module keeps naming project-shape as
// where its vocabulary comes from. A type-only import, which erases before emit.
import type { LedgerKind } from '@agent-kit/payload/ledger-index';

export type { LedgerKind };

/**
 * One choice on a single-select field.
 *
 * All three fields are required by `ProjectV2SingleSelectFieldOptionInput`, including
 * `description`, which the API rejects the whole mutation for omitting rather than defaulting.
 */
export interface SelectOption {
  name: string;
  color: SelectOptionColor;
  description: string;
}

/** The colors `ProjectV2SingleSelectFieldOptionColor` accepts. */
export type SelectOptionColor =
  'GRAY' | 'BLUE' | 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED' | 'PINK' | 'PURPLE';

/**
 * A project field to create.
 *
 * `ITERATION` carries an `iterationConfiguration`, which `gh project field-create` cannot send.
 * Only the GraphQL `createProjectV2Field` mutation accepts it, which is why the bootstrap path
 * builds fields through `ghGraphql` rather than the porcelain command.
 */
export type FieldSpec =
  | { name: string; dataType: 'TEXT' | 'NUMBER' | 'DATE' }
  | {
      name: string;
      dataType: 'SINGLE_SELECT';
      options: readonly SelectOption[];
    }
  | {
      name: string;
      dataType: 'ITERATION';
      iteration: { startDate: string; duration: number };
    };

const KIND_LABEL: Record<LedgerKind, string> = {
  backlog: 'Backlog',
  decisions: 'Decisions',
};

/**
 * The deterministic project title for one ledger.
 *
 * One board per ledger per REPO, not per target. A target is carried by the {@link areaForSurface}
 * value on each item instead. Boards per target multiply: this repo declared one target and still
 * produced four boards, and a fourteen-package workspace would produce twenty-eight.
 *
 * The repo name stays in the title because one GitHub account holds boards for many repos, and a
 * bare `Backlog` is ambiguous across them.
 *
 * Deterministic because it is also the adoption key: `bootstrap` looks for an existing project by
 * exact title before creating one, so a second run adopts rather than duplicates.
 */
export function projectTitle(repoName: string, kind: LedgerKind): string {
  return `${repoName} ${KIND_LABEL[kind]}`;
}

/**
 * The `Area` value for the repo-root surface, which has no target name to carry.
 *
 * A readable sentinel rather than an empty string, because this is a column people read on the
 * board. {@link surfaceForArea} maps it back, and the pair is the contract.
 */
export const AREA_REPO_ROOT = 'repo root';

/**
 * The `Area` value for a surface: the bare target name, or {@link AREA_REPO_ROOT}.
 *
 * Kept beside its inverse deliberately. These two lived in different files and drifted, so the
 * backlog board stored `agent-kit` while the projection read it straight back as the surface and
 * the `.BACKLOG.md` suffix was silently lost. One file, one pair, one round trip.
 */
export function areaForSurface(surface: string): string {
  const match = surface.match(/^(.+)\.(BACKLOG|DECISIONS)\.md$/);
  return match ? match[1] : AREA_REPO_ROOT;
}

/** The surface an `Area` names, the exact inverse of {@link areaForSurface}. */
export function surfaceForArea(area: string, kind: LedgerKind): string {
  const basename = kind === 'backlog' ? 'BACKLOG.md' : 'DECISIONS.md';
  if (area === AREA_REPO_ROOT || area === '') return basename;
  return `${area}.${basename}`;
}

/**
 * The fields one ledger kind's project carries.
 *
 * Backlog mirrors the "Iterative development" template, which has no API path: `createProjectV2`
 * takes only `ownerId`, `title`, `repositoryId`, and `teamId`, so the template's shape is
 * rebuilt here rather than copied. Saved views are not reproducible and are a documented
 * non-goal.
 */
const ITERATION_START_DATE = '2026-01-01';
const ITERATION_DURATION_DAYS = 14;

const BACKLOG_FIELDS: readonly FieldSpec[] = [
  {
    name: 'Status',
    dataType: 'SINGLE_SELECT',
    options: [
      { name: 'Todo', color: 'GRAY', description: 'Logged, not started' },
      { name: 'In Progress', color: 'YELLOW', description: 'Being worked on' },
      { name: 'Done', color: 'GREEN', description: 'Resolved' },
    ],
  },
  {
    name: 'Iteration',
    dataType: 'ITERATION',
    iteration: {
      startDate: ITERATION_START_DATE,
      duration: ITERATION_DURATION_DAYS,
    },
  },
  { name: 'Estimate', dataType: 'NUMBER' },
  {
    name: 'Priority',
    dataType: 'SINGLE_SELECT',
    options: [
      { name: 'P0', color: 'RED', description: 'Blocking' },
      { name: 'P1', color: 'ORANGE', description: 'Next' },
      { name: 'P2', color: 'BLUE', description: 'Someday' },
    ],
  },
  { name: 'Area', dataType: 'TEXT' },
  // Below here: columns that exist so the board can rebuild the local index. A rendered entry
  // shows its filing date and the chat it came from, and neither is derivable from the item.
  // `Created` is when the item reached the board, which is a different date and often a much
  // later one.
  { name: 'Filed', dataType: 'DATE' },
  { name: 'Chat', dataType: 'TEXT' },
];

const DECISIONS_FIELDS: readonly FieldSpec[] = [
  {
    name: 'Status',
    dataType: 'SINGLE_SELECT',
    options: [
      { name: 'Accepted', color: 'GREEN', description: 'Current decision' },
      {
        name: 'Superseded',
        color: 'GRAY',
        description: 'Replaced by a later decision',
      },
    ],
  },
  { name: 'Decided', dataType: 'DATE' },
  { name: 'Supersedes', dataType: 'TEXT' },
  // The mirror of Supersedes, and the two are not interchangeable. Supersedes lists what this
  // record replaced. Superseded by names the one record that replaced it, which is what makes a
  // superseded row navigable forward to the decision that is current.
  { name: 'Superseded by', dataType: 'TEXT' },
  { name: 'Chat', dataType: 'TEXT' },
  // Below here: columns that exist so the board can rebuild the local index. Without them a
  // pulled index answers `scope <path>` with nothing, because the scope list is on 38 of this
  // repo's 41 records and lived only in the local ledger.
  { name: 'Scope', dataType: 'TEXT' },
  { name: 'Under', dataType: 'TEXT' },
  { name: 'Area', dataType: 'TEXT' },
];

export function fieldsFor(kind: LedgerKind): readonly FieldSpec[] {
  return kind === 'backlog' ? BACKLOG_FIELDS : DECISIONS_FIELDS;
}

/**
 * How a list-valued field is stored in a project TEXT column, and read back.
 *
 * Comma-space, matching how `Supersedes` was already written before this existed. Declared here so
 * the backfill writer and the board reader cannot disagree, which is the failure that would show
 * up as a scope query silently matching nothing.
 */
export function joinListField(values: readonly string[]): string {
  return values.join(', ');
}

export function splitListField(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * The HTML comment that ties an issue body to its ledger entry.
 *
 * An HTML comment because it has to survive round-tripping through the GitHub web editor
 * without being visible to whoever reads the issue.
 */
const MARKER_PATTERN = /<!-- agent-kit:entry:(\S+) -->/;

export function formatMarker(entryId: string): string {
  return `<!-- agent-kit:entry:${entryId} -->`;
}

/** The entry id in `body`'s marker, or null when it carries none. */
export function parseMarker(body: string): string | null {
  const match = body.match(MARKER_PATTERN);
  return match ? match[1] : null;
}

/**
 * `body` with `entryId`'s marker appended, or unchanged when it already carries one.
 *
 * Append, never rewrite. An adopted issue's text belongs to whoever reported it, and this is the
 * only write the adopt path is allowed to make to it.
 */
export function appendMarker(body: string, entryId: string): string {
  if (parseMarker(body) !== null) return body;
  return `${body.replace(/\s+$/, '')}\n\n${formatMarker(entryId)}`;
}
