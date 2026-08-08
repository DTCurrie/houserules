import { describe, expect, it } from 'vitest';

import { describeStep, planBootstrap, planIsNoop } from '../bootstrap-plan.mjs';
import type { ExistingProject } from '../bootstrap-plan.mjs';

const REPO_NAME = 'schoolyard-games';
const TARGETS = [{ name: null }, { name: 'studio' }];

const BACKLOG_FIELD_NAMES = [
  'Status',
  'Iteration',
  'Estimate',
  'Priority',
  'Area',
];
const DECISIONS_FIELD_NAMES = [
  'Status',
  'Decided',
  'Supersedes',
  'Superseded by',
  'Chat',
];

function completeProject(
  title: string,
  number: number,
  fieldNames: readonly string[],
): ExistingProject {
  return { number, id: `PVT_${number}`, title, fieldNames };
}

describe('planBootstrap', () => {
  it('creates one step per ledger kind per target when nothing exists', () => {
    const steps = planBootstrap(REPO_NAME, TARGETS, []);

    expect(steps).toHaveLength(4);
    expect(steps.every((step) => step.action === 'create')).toBe(true);
    expect(planIsNoop(steps)).toBe(false);
  });

  it('adopts every project with nothing missing when all fields are already present', () => {
    const existing: ExistingProject[] = [
      completeProject('schoolyard-games Backlog', 1, BACKLOG_FIELD_NAMES),
      completeProject('schoolyard-games Decisions', 2, DECISIONS_FIELD_NAMES),
      completeProject(
        'schoolyard-games/studio Backlog',
        3,
        BACKLOG_FIELD_NAMES,
      ),
      completeProject(
        'schoolyard-games/studio Decisions',
        4,
        DECISIONS_FIELD_NAMES,
      ),
    ];

    const steps = planBootstrap(REPO_NAME, TARGETS, existing);

    expect(steps).toHaveLength(4);
    expect(steps.every((step) => step.action === 'adopt')).toBe(true);
    expect(
      steps.every(
        (step) => step.action === 'adopt' && step.missingFields.length === 0,
      ),
    ).toBe(true);
    expect(planIsNoop(steps)).toBe(true);
  });

  it('carries the matched project number and id into an adopt step', () => {
    const existing: ExistingProject[] = [
      completeProject('schoolyard-games Backlog', 7, BACKLOG_FIELD_NAMES),
    ];

    const steps = planBootstrap(REPO_NAME, [{ name: null }], existing);
    const backlogStep = steps.find((step) => step.kind === 'backlog');

    expect(backlogStep?.action).toBe('adopt');
    expect(backlogStep).toMatchObject({ number: 7, id: 'PVT_7' });
  });

  it('lists exactly the one missing field on an adopt step', () => {
    const existing: ExistingProject[] = [
      completeProject('schoolyard-games Backlog', 1, [
        'Status',
        'Iteration',
        'Estimate',
        'Area',
      ]),
    ];

    const steps = planBootstrap(REPO_NAME, [{ name: null }], existing);
    const backlogStep = steps.find((step) => step.kind === 'backlog');

    expect(backlogStep?.action).toBe('adopt');
    expect(
      backlogStep?.action === 'adopt'
        ? backlogStep.missingFields.map((field) => field.name)
        : [],
    ).toEqual(['Priority']);
    expect(planIsNoop(steps)).toBe(false);
  });

  it('adopts a project carrying an extra field without proposing its removal', () => {
    const existing: ExistingProject[] = [
      completeProject('schoolyard-games Backlog', 1, [
        ...BACKLOG_FIELD_NAMES,
        'Owner',
      ]),
      completeProject('schoolyard-games Decisions', 2, DECISIONS_FIELD_NAMES),
    ];

    const steps = planBootstrap(REPO_NAME, [{ name: null }], existing);
    const backlogStep = steps.find((step) => step.kind === 'backlog');

    expect(backlogStep?.action).toBe('adopt');
    expect(
      backlogStep?.action === 'adopt' ? backlogStep.missingFields : [],
    ).toEqual([]);
    expect(planIsNoop(steps)).toBe(true);
  });

  it('does not adopt a project whose title merely contains the target title', () => {
    const existing: ExistingProject[] = [
      completeProject(
        'schoolyard-games Backlog Archive',
        1,
        BACKLOG_FIELD_NAMES,
      ),
    ];

    const steps = planBootstrap(REPO_NAME, [{ name: null }], existing);
    const backlogStep = steps.find((step) => step.kind === 'backlog');

    expect(backlogStep?.action).toBe('create');
  });
});

describe('planIsNoop', () => {
  it('is true for an empty plan', () => {
    expect(planIsNoop([])).toBe(true);
  });

  it('is false when any step is a create', () => {
    const steps = planBootstrap(REPO_NAME, [{ name: null }], []);

    expect(planIsNoop(steps)).toBe(false);
  });
});

describe('describeStep', () => {
  it('describes a create step with its title and field count', () => {
    const steps = planBootstrap(REPO_NAME, [{ name: null }], []);
    const backlogStep = steps.find((step) => step.kind === 'backlog');

    expect(backlogStep && describeStep(backlogStep)).toBe(
      'create "schoolyard-games Backlog" with 5 fields',
    );
  });

  it('describes an adopt step with its title, number, and missing field count', () => {
    const existing: ExistingProject[] = [
      completeProject('schoolyard-games Backlog', 9, [
        'Status',
        'Iteration',
        'Estimate',
        'Area',
      ]),
    ];

    const steps = planBootstrap(REPO_NAME, [{ name: null }], existing);
    const backlogStep = steps.find((step) => step.kind === 'backlog');

    expect(backlogStep && describeStep(backlogStep)).toBe(
      'adopt "schoolyard-games Backlog" (#9), 1 missing field',
    );
  });
});
