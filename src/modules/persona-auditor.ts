import type { Action, ModuleGroup } from '../types.js';
import { template } from './shared.js';

export const id = 'persona-auditor';
export const title =
  'Persona-auditor agent template (blind-rank-then-reconcile)';
export const group: ModuleGroup = 'optional';

export function hint(): string {
  return 'reference template: a read-only auditor that blind-ranks options from a persona before revealing the system choice';
}

export function defaultEnabled(): boolean {
  return false;
}

/**
 * A template-only reference pattern: a read-only, single-JSON-output auditor that
 * blind-ranks a component's options from a persona's stated priorities before reconciling
 * against what the system actually chose, bucketing divergences by a typed cause.
 *
 * The anti-anchoring discipline ("do not read the scoring code") is the non-obvious part.
 * The per-repo fan-out skill is deferred, because its decision-stream input is bespoke
 * per repo and cannot ship generically.
 */
export function plan(): Action[] {
  return [
    template(
      id,
      'agents/persona-auditor.agent.md.template',
      'blind-rank-then-reconcile persona-auditor pattern',
    ),
    {
      kind: 'advise',
      text: 'Persona audits: instantiate .claude/kit-templates/agents/persona-auditor.agent.md.template per component — it blind-ranks options from a persona before revealing the system choice (anti-anchoring is the point; keep it read-only + haiku).',
      module: id,
    },
  ];
}
