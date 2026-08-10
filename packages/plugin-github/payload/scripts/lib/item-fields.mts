/**
 * The project field values one pushed entry carries, and the GraphQL literal that sets them.
 *
 * Pure. Separated from {@link push-queue} because the two answer different questions: that one
 * decides WHICH entries move, this one decides WHAT each item's fields say once it is there.
 */

import { areaForSurface } from './project-shape.mjs';

/**
 * `values` plus the provenance a backlog item needs to be rebuilt from the board alone.
 *
 * `Filed` and `Chat` were added as columns and only ever written by `backfill`, so anything
 * created after that migration reached the board without them and rendered `????-??-??` once the
 * queue drained. A column the index reads has to be written by the path that creates the item,
 * not only by the one that repairs it.
 */
function withProvenance(
  op: { date: string; chat: string | null },
  values: FieldValue[],
): FieldValue[] {
  const out = [...values];
  if (op.date) out.push({ field: 'Filed', kind: 'date', value: op.date });
  if (op.chat !== null)
    out.push({ field: 'Chat', kind: 'text', value: op.chat });
  return out;
}
import type { PushOp } from './push-queue.mjs';

/**
 * One field assignment, named rather than keyed by id.
 *
 * Names, because the executor resolves a name to its field id and, for a single select, its
 * option id at push time. A project the maintainer customized may carry different ids than the
 * one that created them, and the name is what survives that.
 */
export type FieldValue =
  | { field: string; kind: 'text'; value: string }
  | { field: string; kind: 'number'; value: number }
  | { field: string; kind: 'date'; value: string }
  | { field: string; kind: 'single-select'; option: string };

/**
 * The field values `op` implies for its board item.
 *
 * Returns an empty list for an op that sets no fields, such as `report-move`. An op whose fields
 * are empty must still be treated as successful, since not every operation touches the board's
 * columns.
 *
 * Backlog items get `Status` and `Area`. `Status` is `Todo` for a fresh entry and `Done` for a
 * closed one. `Area` records the surface the entry came from, which is provenance rather than
 * routing: the surface already picked the board.
 *
 * Decision items get `Status`, `Decided`, `Supersedes`, and `Chat`. `Status` is `Accepted`
 * unless the op is `mark-superseded`. `Supersedes` is a comma-joined id list, empty when the
 * record supersedes nothing.
 */
export function fieldValuesFor(op: PushOp): FieldValue[] {
  switch (op.op) {
    case 'create-issue':
    case 'attach-issue':
    case 'update-issue':
      return withProvenance(op, [
        { field: 'Status', kind: 'single-select', option: 'Todo' },
        { field: 'Area', kind: 'text', value: areaForSurface(op.surface) },
      ]);
    case 'close-issue':
      return [
        { field: 'Status', kind: 'single-select', option: 'Done' },
        { field: 'Area', kind: 'text', value: areaForSurface(op.surface) },
      ];
    case 'create-draft': {
      const values: FieldValue[] = [
        { field: 'Status', kind: 'single-select', option: 'Accepted' },
        { field: 'Decided', kind: 'date', value: op.date },
        { field: 'Area', kind: 'text', value: areaForSurface(op.surface) },
      ];
      if (op.supersedes.length > 0) {
        values.push({
          field: 'Supersedes',
          kind: 'text',
          value: op.supersedes.join(', '),
        });
      }
      if (op.chat !== null) {
        values.push({ field: 'Chat', kind: 'text', value: op.chat });
      }
      return values;
    }
    case 'update-draft':
      return [
        { field: 'Status', kind: 'single-select', option: 'Accepted' },
        { field: 'Area', kind: 'text', value: areaForSurface(op.surface) },
      ];
    case 'mark-superseded':
      return [
        { field: 'Status', kind: 'single-select', option: 'Superseded' },
        { field: 'Superseded by', kind: 'text', value: op.successorId },
      ];
    case 'report-move':
      return [];
    default: {
      const unreachable: never = op;
      throw new Error(
        `fieldValuesFor: unhandled op ${JSON.stringify(unreachable)}`,
      );
    }
  }
}

/** Which project field names on the boards this plugin creates hold a date rather than text. */
const DATE_FIELD_NAMES: ReadonlySet<string> = new Set(['Filed', 'Decided']);

/** The `set-field` value {@link FieldValue} for a `backfill` write of `field` to `value`. */
export function backfillFieldValue(field: string, value: string): FieldValue {
  return DATE_FIELD_NAMES.has(field)
    ? { field, kind: 'date', value }
    : { field, kind: 'text', value };
}

/**
 * The `updateProjectV2ItemFieldValue` `value:` literal for one field.
 *
 * Built as a GraphQL literal rather than passed as a variable, matching how the bootstrap path
 * builds its field inputs, because `gh api graphql` variables carry only scalars.
 *
 * @param optionId Required for a single select and ignored otherwise. The executor resolves it
 *   from the field's options by name, since option ids are per-project.
 */
export function fieldValueLiteral(
  value: FieldValue,
  optionId?: string,
): string {
  switch (value.kind) {
    case 'text':
      return `{ text: ${JSON.stringify(value.value)} }`;
    case 'number':
      return `{ number: ${value.value} }`;
    case 'date':
      return `{ date: ${JSON.stringify(value.value)} }`;
    case 'single-select':
      if (!optionId) {
        throw new Error(
          `fieldValueLiteral: missing optionId for single select field "${value.field}"`,
        );
      }
      return `{ singleSelectOptionId: ${JSON.stringify(optionId)} }`;
    default: {
      const unreachable: never = value;
      throw new Error(
        `fieldValueLiteral: unhandled kind ${JSON.stringify(unreachable)}`,
      );
    }
  }
}
