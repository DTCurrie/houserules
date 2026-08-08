/**
 * What a synced project looks like: its title, its fields, and the marker that ties a GitHub
 * issue back to the ledger entry it came from.
 *
 * Entirely pure. No `gh`, no disk. Every rule about naming and shape lives here so the bootstrap
 * and push paths cannot disagree about what they are looking for.
 */

export type LedgerKind = 'backlog' | 'decisions';

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
 * The segment that names one target on its board, so a monorepo reads `repo/cli` and
 * `repo/plugin-prose` rather than repeating whatever the target happens to be called.
 *
 * Derived from `pathPrefix`, not from `name`. A target's `name` is user-chosen and need not
 * resemble the directory it governs. This repo's sole target is named `agent-kit` while
 * governing `packages/cli/`, which titled its board `agent-kit/agent-kit`, indistinguishable
 * from the repo root's.
 *
 * Renaming the target instead would have been the obvious fix and is the expensive one. The
 * ledgers key their surfaces off the target name, and {@link normalizeSurfaceRef} returns a
 * recorded name carrying no slash unchanged, so `agent-kit.BACKLOG.md` would keep resolving to
 * itself while new entries went to `cli.BACKLOG.md`. Deriving the board segment here leaves
 * every recorded entry where it is.
 *
 * @returns Null for the repo root. Otherwise the last path segment, falling back to `name` for
 *   a target with no `pathPrefix`, which is how a single-package repo declares itself.
 */
export function targetSegment(target: {
  name: string | null;
  pathPrefix?: string;
}): string | null {
  if (target.name === null) return null;
  const trimmed = (target.pathPrefix ?? '').replace(/\/+$/, '');
  const basename = trimmed.split('/').filter(Boolean).pop();
  return basename ?? target.name;
}

/**
 * The deterministic project title for one ledger and one target.
 *
 * Deterministic because it is also the adoption key: `bootstrap` looks for an existing project
 * by exact title before creating one, so a second run adopts rather than duplicates. A title
 * that varied by run would create a new board every time, and a title changed after the fact
 * orphans the board it used to name.
 *
 * @param segment The target's board segment from {@link targetSegment}, or null for the root.
 */
export function projectTitle(
  repoName: string,
  kind: LedgerKind,
  segment: string | null,
): string {
  const label = KIND_LABEL[kind];
  const subject = segment === null ? repoName : `${repoName}/${segment}`;
  return `${subject} ${label}`;
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
  // superseded row navigable forward to the decision that is actually current.
  { name: 'Superseded by', dataType: 'TEXT' },
  { name: 'Chat', dataType: 'TEXT' },
];

export function fieldsFor(kind: LedgerKind): readonly FieldSpec[] {
  return kind === 'backlog' ? BACKLOG_FIELDS : DECISIONS_FIELDS;
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
