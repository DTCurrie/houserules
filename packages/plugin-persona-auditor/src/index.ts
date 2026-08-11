import { definePlugin } from '@agent-kit/api';
import type { Action, ModuleDef, PluginApi } from '@agent-kit/api';

/**
 * A template-only reference pattern: a read-only, single-JSON-output auditor that
 * blind-ranks a component's options from a persona's stated priorities before reconciling
 * against what the system actually chose, bucketing divergences by a typed cause.
 *
 * The anti-anchoring discipline ("do not read the scoring code") is the non-obvious part.
 * The per-repo fan-out skill is deferred, because its decision-stream input is bespoke
 * per repo and cannot ship generically.
 */
function personaAuditorModule(api: PluginApi): ModuleDef {
  const id = 'persona-auditor';
  return {
    id,
    title: 'Persona-auditor agent template (blind-rank-then-reconcile)',
    group: 'optional',
    hint(): string {
      return 'reference template: a read-only auditor that blind-ranks options from a persona before revealing the system choice';
    },
    defaultEnabled(): boolean {
      return false;
    },
    plan(): Action[] {
      return [
        api.payload.template(
          id,
          'agents/persona-auditor.agent.md.template',
          'blind-rank-then-reconcile persona-auditor pattern',
        ),
        {
          kind: 'advise',
          text: 'Persona audits: instantiate .claude/kit-templates/agents/persona-auditor.agent.md.template per component — it blind-ranks options from a persona before revealing the system choice (anti-anchoring is the point, so keep it read-only and haiku).',
          module: id,
        },
      ];
    },
  };
}

export default definePlugin((api: PluginApi): ModuleDef[] => [
  personaAuditorModule(api),
]);
