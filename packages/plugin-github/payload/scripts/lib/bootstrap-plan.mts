/**
 * What a `bootstrap` run would do, decided from data alone.
 *
 * Split from the script that executes it so the decisions are testable without a network or an
 * installed tree. `projects-sync.mts` has to import the CLI's installed libs statically, which
 * makes it reachable only through a real install. Nothing in here imports anything but types.
 *
 * Idempotency lives here rather than in the executor. A second `bootstrap` run produces a plan
 * with no creations, and that is the property the phase's acceptance turns on.
 */

import { fieldsFor, projectTitle, targetSegment } from './project-shape.mjs';
import type { FieldSpec, LedgerKind } from './project-shape.mjs';

const LEDGER_KINDS: readonly LedgerKind[] = ['backlog', 'decisions'];

/** A project that already exists under the owner, as read back from GitHub. */
export interface ExistingProject {
  number: number;
  id: string;
  title: string;
  fieldNames: readonly string[];
}

/**
 * One target the kit tracks. Null `name` is the repo root.
 *
 * `pathPrefix` is what names the target on its board, via {@link targetSegment}, so a target
 * whose name does not resemble its directory still reads correctly.
 */
export interface BootstrapTarget {
  name: string | null;
  pathPrefix?: string;
}

/** One project the plan will create from scratch, then populate. */
export interface CreateProjectStep {
  action: 'create';
  kind: LedgerKind;
  targetName: string | null;
  title: string;
  fields: readonly FieldSpec[];
}

/**
 * A project that already exists and is reused.
 *
 * `missingFields` is only the fields absent from it, so a project a user has customized keeps
 * whatever they added. Adoption never deletes a field, and never recreates one that is present.
 */
export interface AdoptProjectStep {
  action: 'adopt';
  kind: LedgerKind;
  targetName: string | null;
  title: string;
  number: number;
  id: string;
  missingFields: readonly FieldSpec[];
}

export type BootstrapStep = CreateProjectStep | AdoptProjectStep;

/**
 * Every step a `bootstrap` run needs, one per (ledger kind, target) pair.
 *
 * Matching is by exact title, which is why {@link projectTitle} has to be deterministic. A
 * fuzzy match would adopt the wrong board, and no match at all would create a duplicate on
 * every run.
 *
 * @param targets Every tracked target. The caller includes the repo root as `{ name: null }`.
 * @param existing Every project already under the owner, however it got there.
 */
export function planBootstrap(
  repoName: string,
  targets: readonly BootstrapTarget[],
  existing: readonly ExistingProject[],
): BootstrapStep[] {
  const steps: BootstrapStep[] = [];

  for (const target of targets) {
    for (const kind of LEDGER_KINDS) {
      const title = projectTitle(repoName, kind, targetSegment(target));
      const match = existing.find((project) => project.title === title);

      if (match === undefined) {
        steps.push({
          action: 'create',
          kind,
          targetName: target.name,
          title,
          fields: fieldsFor(kind),
        });
        continue;
      }

      const missingFields = fieldsFor(kind).filter(
        (field) => !match.fieldNames.includes(field.name),
      );

      steps.push({
        action: 'adopt',
        kind,
        targetName: target.name,
        title,
        number: match.number,
        id: match.id,
        missingFields,
      });
    }
  }

  return steps;
}

/** Whether `steps` would change anything. False means a re-run is a genuine no-op. */
export function planIsNoop(steps: readonly BootstrapStep[]): boolean {
  return steps.every(
    (step) => step.action === 'adopt' && step.missingFields.length === 0,
  );
}

/** One human-readable line per step, for `--dry-run` and for the run summary. */
export function describeStep(step: BootstrapStep): string {
  const fieldCount =
    step.action === 'create' ? step.fields.length : step.missingFields.length;
  const fieldNoun = fieldCount === 1 ? 'field' : 'fields';

  return step.action === 'create'
    ? `create "${step.title}" with ${fieldCount} ${fieldNoun}`
    : `adopt "${step.title}" (#${step.number}), ${fieldCount} missing ${fieldNoun}`;
}
