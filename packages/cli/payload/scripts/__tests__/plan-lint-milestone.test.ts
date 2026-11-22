import { describe, expect, it } from 'vitest';

import {
  checkMilestoneBarRecorded,
  checkMilestoneContracts,
  checkMilestoneDuplicatePhaseSlugs,
  checkMilestoneHeldPathOverlap,
  checkMilestoneHorizonWritten,
  checkMilestoneItemDomains,
  checkMilestoneLiveItems,
  checkMilestoneNeedsMatchBlocks,
  checkMilestoneOneOpenStep,
  checkMilestoneOpenGates,
  checkMilestoneOwnerItems,
  checkMilestonePhaseInTwoSteps,
  checkMilestoneResources,
  checkMilestoneStepDoneEarly,
  checkMilestoneStepTodoLate,
  checkMilestoneUnknownItems,
  checkMilestoneUnscheduledPhases,
  formatGateLines,
  parseMilestone,
  type MemberPhase,
  type MemberPlans,
  type Milestone,
} from '../plan-lint.mjs';

const FULL = `# MILESTONE: demo

**Status:** IN PROGRESS · **Started:** 2026-11-01 · **Updated:** 2026-11-19

## Goal

Ship it.

## Members

| Member | Owns | Verify |
| --- | --- | --- |
| \`backend\` | accounts and the API | \`pnpm --filter api check\` |
|\`web\`|the web app|\`pnpm --filter web check\`|

## Held paths

- \`pnpm-lock.yaml\`
- \`contracts/\`
- \`docs\`

## Contracts

| Id  | Path                 | Version | Producer             | Consumers                          |
| --- | -------------------- | ------- | -------------------- | ---------------------------------- |
| C1  | \`contracts/api.yaml\` | 2       | \`backend/signup-api\` | \`web/signup-form\`, \`mobile/signup\` |
|C2|\`contracts/b.yaml\`|x|\`backend/b\`|\`web/b\`|

## Resources

- \`bench-rig\`: the one provisioned device
- \`sim\`: a simulator

## Gates

- G1 · OPEN · decision · auth approach · blocks \`sign-up\`
- G2 · WAIVED (2026-11-19, no time to spike) · spike · latency · blocks \`provision\`

## Steps

### Step: skeleton · Status: DONE (2026-11-10)

Every surface builds.

- Items: \`backend/scaffold\`, \`web/scaffold\`
- Seam: none
- Close: \`pnpm check\`
- Needs: none

### Step: sign-up · Status: TODO

A user signs up.

- Items: \`backend/signup-api\`, \`web/signup-form\`,
  \`mobile/signup\`
- Seam: contract C1 at version 2
- Close: \`pnpm test:e2e signup\`
- Needs: G1, G2
- Uses: \`web/signup-form\` holds \`bench-rig\`, \`mobile/signup\` holds \`sim\`

### Step: provision · Status: TODO

Items are written when this step is next.

## Log

- 2026-11-19: started
`;

describe('parseMilestone', () => {
  const milestone = parseMilestone(FULL);

  it('reads the status header', () => {
    expect(milestone.status).toBe('IN PROGRESS');
  });

  it('reads padded and unpadded member rows', () => {
    expect(milestone.members).toEqual([
      {
        name: 'backend',
        owns: 'accounts and the API',
        verify: 'pnpm --filter api check',
      },
      { name: 'web', owns: 'the web app', verify: 'pnpm --filter web check' },
    ]);
  });

  it('strips trailing slashes from held paths and keeps bare ones', () => {
    expect(milestone.heldPaths).toEqual([
      'pnpm-lock.yaml',
      'contracts',
      'docs',
    ]);
  });

  it('reads contracts, with a null version for a non-integer cell', () => {
    expect(milestone.contracts).toEqual([
      {
        id: 'C1',
        path: 'contracts/api.yaml',
        version: 2,
        producer: 'backend/signup-api',
        consumers: ['web/signup-form', 'mobile/signup'],
      },
      {
        id: 'C2',
        path: 'contracts/b.yaml',
        version: null,
        producer: 'backend/b',
        consumers: ['web/b'],
      },
    ]);
  });

  it('reads the backticked resource name before the colon', () => {
    expect(milestone.resources).toEqual(['bench-rig', 'sim']);
  });

  it('splits gates on the middle dot and drops a waiver parenthetical from the state', () => {
    expect(milestone.gates).toEqual([
      {
        id: 'G1',
        state: 'OPEN',
        kind: 'decision',
        subject: 'auth approach',
        blocks: 'sign-up',
      },
      {
        id: 'G2',
        state: 'WAIVED',
        kind: 'spike',
        subject: 'latency',
        blocks: 'provision',
      },
    ]);
  });

  it('reads steps in order, with and without a status parenthetical', () => {
    expect(milestone.steps.map((step) => [step.slug, step.status])).toEqual([
      ['skeleton', 'DONE (2026-11-10)'],
      ['sign-up', 'TODO'],
      ['provision', 'TODO'],
    ]);
  });

  it('reads a one-line Items, Seam, Close, and Needs none', () => {
    expect(milestone.steps[0]).toEqual({
      slug: 'skeleton',
      status: 'DONE (2026-11-10)',
      items: ['backend/scaffold', 'web/scaffold'],
      seam: 'none',
      close: 'pnpm check',
      needs: [],
      uses: [],
      line: 41,
    });
  });

  it('joins a wrapped Items line and reads Needs and Uses lists', () => {
    expect(milestone.steps[1]).toMatchObject({
      items: ['backend/signup-api', 'web/signup-form', 'mobile/signup'],
      seam: 'contract C1 at version 2',
      close: 'pnpm test:e2e signup',
      needs: ['G1', 'G2'],
      uses: [
        { item: 'web/signup-form', resource: 'bench-rig' },
        { item: 'mobile/signup', resource: 'sim' },
      ],
    });
  });

  it('gives a step with no Items line null items and empty lists', () => {
    expect(milestone.steps[2]).toMatchObject({
      items: null,
      seam: null,
      close: null,
      needs: [],
      uses: [],
    });
  });

  it('reads a milestone with zero steps and no other sections', () => {
    expect(parseMilestone('# MILESTONE: x\n\n## Steps\n')).toEqual({
      status: null,
      members: [],
      heldPaths: [],
      contracts: [],
      resources: [],
      gates: [],
      steps: [],
      log: [],
    });
  });

  it('reads the Log bullets', () => {
    expect(parseMilestone('## Log\n\n- one\n- two. Bar: x.\n').log).toEqual([
      'one',
      'two. Bar: x.',
    ]);
  });
});

const FILE = '.claude/plans/demo/MILESTONE.md';

const MEMBERS_TABLE = `# MILESTONE: demo

**Status:** IN PROGRESS · **Started:** 2026-11-01

## Members

| Member | Owns | Verify |
| --- | --- | --- |
| \`backend\` | the API | \`pnpm --filter api check\` |
|\`web\`|the web app|\`pnpm --filter web check\`|
`;

function milestoneOf(sections: string): Milestone {
  return parseMilestone(`${MEMBERS_TABLE}\n${sections}`);
}

function phase(
  number: number,
  slug: string,
  overrides: Partial<Omit<MemberPhase, 'number' | 'slug'>>,
): MemberPhase {
  return {
    number,
    slug,
    status: 'TODO',
    domain: [`packages/${slug}`],
    signals: [],
    ...overrides,
  };
}

type MilestoneCheck = (
  file: string,
  milestone: Milestone,
  members: MemberPlans,
) => ReturnType<typeof checkMilestoneUnknownItems>;

function rulesOf(
  check: MilestoneCheck,
  milestone: Milestone,
  members: MemberPlans,
): Array<[string, string]> {
  return check(FILE, milestone, members).findings.map((finding) => [
    finding.rule,
    finding.level,
  ]);
}

const SHARED_SLUG_PLANS: MemberPlans = {
  backend: [
    phase(1, 'scaffold', { status: 'DONE (2026-11-10)', domain: ['api'] }),
    phase(2, 'signup', { domain: ['api/signup'] }),
  ],
  web: [
    phase(1, 'scaffold', { status: 'DONE', domain: ['web'] }),
    phase(2, 'signup', { domain: ['web/signup'] }),
  ],
};

describe('checkMilestoneUnknownItems', () => {
  it.each([
    ['a member missing from the table', '`mobile/signup`'],
    ['a slug the member does not have', '`web/checkout`'],
    ['a reference with no phase slug', '`backend`'],
  ])('errors on an item naming %s', (_case, item) => {
    const milestone = milestoneOf(`## Steps

### Step: one · Status: TODO

- Items: \`backend/signup\`, ${item}
`);

    expect(
      rulesOf(checkMilestoneUnknownItems, milestone, SHARED_SLUG_PLANS),
    ).toEqual([['milestone/unknown-item', 'error']]);
  });

  it('puts the finding on the line of the step heading', () => {
    const milestone = milestoneOf(`## Steps

### Step: one · Status: TODO

- Items: \`web/checkout\`
`);

    expect(
      checkMilestoneUnknownItems(FILE, milestone, SHARED_SLUG_PLANS).findings[0]
        ?.line,
    ).toBe(14);
  });

  it('resolves one slug under two members as two phases', () => {
    const milestone = milestoneOf(`## Steps

### Step: skeleton · Status: DONE (2026-11-10)

- Items: \`backend/scaffold\`, \`web/scaffold\`
`);

    expect(
      rulesOf(checkMilestoneUnknownItems, milestone, SHARED_SLUG_PLANS),
    ).toEqual([]);
  });
});

describe('checkMilestoneDuplicatePhaseSlugs', () => {
  it('errors once per member that repeats a slug, naming the slug', () => {
    const plans: MemberPlans = {
      backend: [
        phase(1, 'auth', {}),
        phase(2, 'auth', {}),
        phase(3, 'auth', {}),
      ],
      web: [phase(1, 'form', {}), phase(2, 'form', {})],
    };

    const findings = checkMilestoneDuplicatePhaseSlugs(
      FILE,
      milestoneOf(''),
      plans,
    ).findings;

    expect(
      findings.map((finding) => [
        finding.rule,
        finding.level,
        finding.msg.match(/`(\w+\/\w+)`/)?.[1],
      ]),
    ).toEqual([
      ['milestone/duplicate-phase-slug', 'error', 'backend/auth'],
      ['milestone/duplicate-phase-slug', 'error', 'web/form'],
    ]);
  });

  it('passes one slug used once in each of two members', () => {
    expect(
      rulesOf(
        checkMilestoneDuplicatePhaseSlugs,
        milestoneOf(''),
        SHARED_SLUG_PLANS,
      ),
    ).toEqual([]);
  });
});

describe('checkMilestonePhaseInTwoSteps', () => {
  it('errors when a later step holds a phase an earlier step holds', () => {
    const milestone = milestoneOf(`## Steps

### Step: one · Status: TODO

- Items: \`backend/signup\`

### Step: two · Status: TODO

- Items: \`web/signup\`,
  \`backend/signup\`
`);

    expect(
      checkMilestonePhaseInTwoSteps(
        FILE,
        milestone,
        SHARED_SLUG_PLANS,
      ).findings.map((finding) => [finding.rule, finding.level, finding.line]),
    ).toEqual([['milestone/phase-in-two-steps', 'error', 18]]);
  });

  it('passes one slug from two members placed in two steps', () => {
    const milestone = milestoneOf(`## Steps

### Step: one · Status: TODO

- Items: \`backend/signup\`

### Step: two · Status: TODO

- Items: \`web/signup\`
`);

    expect(
      rulesOf(checkMilestonePhaseInTwoSteps, milestone, SHARED_SLUG_PLANS),
    ).toEqual([]);
  });
});

describe('checkMilestoneStepDoneEarly', () => {
  const doneStep = milestoneOf(`## Steps

### Step: one · Status: DONE (2026-11-19)

- Items: \`backend/signup\`, \`web/signup\`
`);

  it('errors on a DONE step whose item is still TODO', () => {
    const plans: MemberPlans = {
      backend: [phase(1, 'signup', { status: 'DONE (2026-11-18)' })],
      web: [phase(1, 'signup', { status: 'TODO' })],
    };

    expect(rulesOf(checkMilestoneStepDoneEarly, doneStep, plans)).toEqual([
      ['milestone/step-done-early', 'error'],
    ]);
  });

  it('passes a DONE step whose items are DONE and DROPPED', () => {
    const plans: MemberPlans = {
      backend: [phase(1, 'signup', { status: 'DONE (2026-11-18)' })],
      web: [phase(1, 'signup', { status: 'DROPPED (2026-11-18, cut)' })],
    };

    expect(rulesOf(checkMilestoneStepDoneEarly, doneStep, plans)).toEqual([]);
  });
});

describe('checkMilestoneStepTodoLate', () => {
  const todoStep = milestoneOf(`## Steps

### Step: one · Status: TODO

- Items: \`backend/signup\`
`);

  it.each(['IN PROGRESS', 'DONE (2026-11-18)'])(
    'errors on a TODO step whose item is %s',
    (status) => {
      const plans: MemberPlans = { backend: [phase(1, 'signup', { status })] };

      expect(rulesOf(checkMilestoneStepTodoLate, todoStep, plans)).toEqual([
        ['milestone/step-todo-late', 'error'],
      ]);
    },
  );

  it('passes a TODO step whose item is TODO', () => {
    const plans: MemberPlans = {
      backend: [phase(1, 'signup', { status: 'TODO' })],
    };

    expect(rulesOf(checkMilestoneStepTodoLate, todoStep, plans)).toEqual([]);
  });
});

describe('checkMilestoneHorizonWritten', () => {
  function horizonSlugs(steps: string): string[] {
    return checkMilestoneHorizonWritten(
      FILE,
      milestoneOf(`## Steps\n\n${steps}`),
      {},
    ).findings.map((finding) => finding.msg.split('`')[1] ?? '');
  }

  it('errors on each of the first two steps not DONE that has no Items line', () => {
    const slugs = horizonSlugs(`### Step: one · Status: DONE (2026-11-18)

A user signs up.

### Step: two · Status: TODO

A user signs in.

### Step: three · Status: TODO

A user resets a password.

### Step: four · Status: TODO

A user deletes the account.
`);

    expect(slugs).toEqual(['two', 'three']);
  });

  it('passes when the open step and the next are written and later steps are scope lines', () => {
    const slugs = horizonSlugs(`### Step: one · Status: IN PROGRESS

- Items: \`backend/signup\`

### Step: two · Status: TODO

- Items: \`web/signup\`

### Step: three · Status: TODO

A user resets a password.
`);

    expect(slugs).toEqual([]);
  });

  it('errors on the step two ahead alone when the open step is written', () => {
    const slugs = horizonSlugs(`### Step: one · Status: IN PROGRESS

- Items: \`backend/signup\`

### Step: two · Status: TODO

A user signs in.
`);

    expect(slugs).toEqual(['two']);
  });

  it('passes a DONE scope line and a lone last step written in full', () => {
    const slugs = horizonSlugs(`### Step: one · Status: DONE (2026-11-18)

A user signs up.

### Step: two · Status: TODO

- Items: \`backend/signup\`
`);

    expect(slugs).toEqual([]);
  });
});

describe('checkMilestoneOneOpenStep', () => {
  it('errors once when two steps are IN PROGRESS', () => {
    const milestone = milestoneOf(`## Steps

### Step: one · Status: IN PROGRESS

### Step: two · Status: IN PROGRESS

### Step: three · Status: IN PROGRESS
`);

    expect(rulesOf(checkMilestoneOneOpenStep, milestone, {})).toEqual([
      ['milestone/one-open-step', 'error'],
    ]);
  });

  it('passes one IN PROGRESS step after a DONE one', () => {
    const milestone = milestoneOf(`## Steps

### Step: one · Status: DONE (2026-11-10)

### Step: two · Status: IN PROGRESS
`);

    expect(rulesOf(checkMilestoneOneOpenStep, milestone, {})).toEqual([]);
  });
});

describe('checkMilestoneOpenGates', () => {
  const withGate = (stepStatus: string, gateState: string): Milestone =>
    milestoneOf(`## Gates

- G1 · ${gateState} · decision · auth approach · blocks \`sign-up\`

## Steps

### Step: sign-up · Status: ${stepStatus}
`);

  it.each(['IN PROGRESS', 'DONE (2026-11-19)'])(
    'errors on a %s step an OPEN gate blocks',
    (stepStatus) => {
      expect(
        rulesOf(checkMilestoneOpenGates, withGate(stepStatus, 'OPEN'), {}),
      ).toEqual([['milestone/open-gate', 'error']]);
    },
  );

  it.each(['CLOSED', 'WAIVED (2026-11-19, no time to spike)'])(
    'passes an IN PROGRESS step whose gate is %s',
    (gateState) => {
      expect(
        rulesOf(
          checkMilestoneOpenGates,
          withGate('IN PROGRESS', gateState),
          {},
        ),
      ).toEqual([]);
    },
  );

  it('passes a TODO step an OPEN gate blocks', () => {
    expect(
      rulesOf(checkMilestoneOpenGates, withGate('TODO', 'OPEN'), {}),
    ).toEqual([]);
  });
});

describe('checkMilestoneItemDomains', () => {
  const pairStep = milestoneOf(`## Steps

### Step: one · Status: TODO

- Items: \`backend/signup\`, \`web/signup\`
`);

  const plansWithDomains = (
    backendDomain: string[] | null,
    webDomain: string[] | null,
  ): MemberPlans => ({
    backend: [phase(1, 'signup', { domain: backendDomain })],
    web: [phase(1, 'signup', { domain: webDomain })],
  });

  it('errors on two items whose roots are parent and child', () => {
    expect(
      rulesOf(
        checkMilestoneItemDomains,
        pairStep,
        plansWithDomains(['packages/api'], ['packages/api/routes']),
      ),
    ).toEqual([['milestone/item-domain-overlap', 'error']]);
  });

  it('passes two items whose roots share only a name prefix', () => {
    expect(
      rulesOf(
        checkMilestoneItemDomains,
        pairStep,
        plansWithDomains(['packages/api'], ['packages/api-client']),
      ),
    ).toEqual([]);
  });

  it('errors on an item with no Domain line in a step holding another item', () => {
    expect(
      rulesOf(
        checkMilestoneItemDomains,
        pairStep,
        plansWithDomains(['packages/api'], null),
      ),
    ).toEqual([['milestone/item-domain-overlap', 'error']]);
  });

  it('passes an item with no Domain line alone in its step', () => {
    const milestone = milestoneOf(`## Steps

### Step: one · Status: TODO

- Items: \`web/signup\`
`);

    expect(
      rulesOf(
        checkMilestoneItemDomains,
        milestone,
        plansWithDomains(['packages/api'], null),
      ),
    ).toEqual([]);
  });

  it('errors on an item Domain root with a glob character', () => {
    expect(
      rulesOf(
        checkMilestoneItemDomains,
        pairStep,
        plansWithDomains(['packages/*'], ['web']),
      ),
    ).toEqual([['milestone/item-domain-overlap', 'error']]);
  });
});

describe('checkMilestoneHeldPathOverlap', () => {
  const heldPaths = (paths: string): Milestone =>
    milestoneOf(`## Held paths

${paths}
`);

  it.each([
    ['a parent of', '- `packages/`'],
    ['a child of', '-   `packages/api/generated`'],
    ['equal to', '- `packages/api`'],
  ])('errors on a held path %s a phase Domain root', (_case, bullet) => {
    const plans: MemberPlans = {
      backend: [phase(1, 'signup', { domain: ['packages/api'] })],
    };

    expect(
      rulesOf(checkMilestoneHeldPathOverlap, heldPaths(bullet), plans),
    ).toEqual([['milestone/held-path-overlap', 'error']]);
  });

  it('passes a held path disjoint from every Domain root', () => {
    const plans: MemberPlans = {
      backend: [phase(1, 'signup', { domain: ['packages/api'] })],
    };

    expect(
      rulesOf(
        checkMilestoneHeldPathOverlap,
        heldPaths('- `pnpm-lock.yaml`\n- `contracts`'),
        plans,
      ),
    ).toEqual([]);
  });

  it.each(['DONE (2026-11-18)', 'DROPPED (2026-11-18, moved to web)'])(
    'skips an overlapping phase that is %s',
    (status) => {
      const plans: MemberPlans = {
        backend: [phase(1, 'signup', { status, domain: ['contracts'] })],
      };

      expect(
        rulesOf(
          checkMilestoneHeldPathOverlap,
          heldPaths('- `contracts`'),
          plans,
        ),
      ).toEqual([]);
    },
  );

  it('errors on a held path with a glob character', () => {
    expect(
      rulesOf(checkMilestoneHeldPathOverlap, heldPaths('- `contracts/*`'), {}),
    ).toEqual([['milestone/held-path-overlap', 'error']]);
  });

  it.each([
    ['the changeset dir', '.changeset'],
    ['a child of the ledgers', '.claude/ledgers/backlog'],
    ['a parent of the ledgers', '.claude'],
  ])(
    'errors on a Domain root overlapping %s, held though no milestone lists it',
    (_case, root) => {
      const plans: MemberPlans = {
        backend: [phase(1, 'signup', { domain: [root] })],
      };

      expect(
        checkMilestoneHeldPathOverlap(
          FILE,
          heldPaths('- `pnpm-lock.yaml`'),
          plans,
        ).findings.map((finding) => finding.rule),
      ).toEqual(['milestone/held-path-overlap']);
    },
  );

  it('reports an always-held path once when the milestone also lists it', () => {
    const plans: MemberPlans = {
      backend: [phase(1, 'notes', { domain: ['.changeset'] })],
    };

    expect(
      checkMilestoneHeldPathOverlap(
        FILE,
        heldPaths('- `.changeset/`'),
        plans,
      ).findings.map((finding) => finding.msg),
    ).toEqual([
      '`backend/notes` Domain root `.changeset` overlaps held path `.changeset`, which only the milestone session writes',
    ]);
  });

  it('passes a Domain root that only shares a name prefix with an always-held path', () => {
    const plans: MemberPlans = {
      backend: [phase(1, 'notes', { domain: ['.changesets-archive'] })],
    };

    expect(
      rulesOf(checkMilestoneHeldPathOverlap, heldPaths(''), plans),
    ).toEqual([]);
  });
});

describe('checkMilestoneLiveItems', () => {
  it('errors on a live item sharing its step', () => {
    const milestone = milestoneOf(`## Steps

### Step: one · Status: TODO

- Items: \`backend/signup\`, \`web/signup\`
`);
    const plans: MemberPlans = {
      backend: [phase(1, 'signup', { signals: ['live'] })],
      web: [phase(1, 'signup', {})],
    };

    expect(rulesOf(checkMilestoneLiveItems, milestone, plans)).toEqual([
      ['milestone/live-item-shared', 'error'],
    ]);
  });

  it('passes a live item alone in its step', () => {
    const milestone = milestoneOf(`## Steps

### Step: one · Status: TODO

- Items: \`backend/signup\`
`);
    const plans: MemberPlans = {
      backend: [phase(1, 'signup', { signals: ['ui', 'live'] })],
    };

    expect(rulesOf(checkMilestoneLiveItems, milestone, plans)).toEqual([]);
  });
});

describe('checkMilestoneResources', () => {
  const withUses = (uses: string): Milestone =>
    milestoneOf(`## Resources

- \`bench-rig\`: the one provisioned device
- \`sim\`: a simulator

## Steps

### Step: one · Status: TODO

- Items: \`backend/signup\`, \`web/signup\`
- Uses: ${uses}
`);

  it('errors on two items holding one resource', () => {
    expect(
      rulesOf(
        checkMilestoneResources,
        withUses(
          '`backend/signup` holds `bench-rig`, `web/signup` holds `bench-rig`',
        ),
        SHARED_SLUG_PLANS,
      ),
    ).toEqual([['milestone/resource-conflict', 'error']]);
  });

  it('errors on a Uses line naming an undeclared resource', () => {
    expect(
      rulesOf(
        checkMilestoneResources,
        withUses('`web/signup` holds `phone`'),
        SHARED_SLUG_PLANS,
      ),
    ).toEqual([['milestone/resource-conflict', 'error']]);
  });

  it('passes two items holding two declared resources', () => {
    expect(
      rulesOf(
        checkMilestoneResources,
        withUses(
          '`backend/signup` holds `sim`, `web/signup` holds `bench-rig`',
        ),
        SHARED_SLUG_PLANS,
      ),
    ).toEqual([]);
  });
});

describe('checkMilestoneOwnerItems', () => {
  const pairStep = milestoneOf(`## Steps

### Step: one · Status: TODO

- Items: \`backend/signup\`, \`web/signup\`
`);

  it('errors on two owner items in one step', () => {
    const plans: MemberPlans = {
      backend: [phase(1, 'signup', { signals: ['owner'] })],
      web: [phase(1, 'signup', { signals: ['ui', 'owner'] })],
    };

    expect(rulesOf(checkMilestoneOwnerItems, pairStep, plans)).toEqual([
      ['milestone/owner-items-shared', 'error'],
    ]);
  });

  it('passes one owner item beside an ordinary item', () => {
    const plans: MemberPlans = {
      backend: [phase(1, 'signup', { signals: ['owner'] })],
      web: [phase(1, 'signup', { signals: ['ui'] })],
    };

    expect(rulesOf(checkMilestoneOwnerItems, pairStep, plans)).toEqual([]);
  });
});

describe('checkMilestoneContracts', () => {
  it('errors on a producer and a consumer that do not resolve', () => {
    const milestone = milestoneOf(`## Contracts

| Id | Path | Version | Producer | Consumers |
| --- | --- | --- | --- | --- |
|C1|\`contracts/api.yaml\`|2|\`backend/billing\`|\`web/signup\`, \`mobile/signup\`|
`);

    expect(
      rulesOf(checkMilestoneContracts, milestone, SHARED_SLUG_PLANS),
    ).toEqual([
      ['milestone/contract-unresolved', 'error'],
      ['milestone/contract-unresolved', 'error'],
    ]);
  });

  it('passes a contract whose producer and consumers all resolve', () => {
    const milestone = milestoneOf(`## Contracts

| Id  | Path                 | Version | Producer           | Consumers         |
| --- | -------------------- | ------- | ------------------ | ----------------- |
| C1  | \`contracts/api.yaml\` | 2       | \`backend/signup\` | \`web/signup\`    |
`);

    expect(
      rulesOf(checkMilestoneContracts, milestone, SHARED_SLUG_PLANS),
    ).toEqual([]);
  });
});

describe('checkMilestoneUnscheduledPhases', () => {
  it('stays quiet on an open phase in no step while a later step is a scope line', () => {
    const milestone = milestoneOf(`## Steps

### Step: one · Status: TODO

- Items: \`backend/signup\`

### Step: two · Status: TODO

Items are written when this step is next.
`);

    expect(
      rulesOf(checkMilestoneUnscheduledPhases, milestone, SHARED_SLUG_PLANS),
    ).toEqual([]);
  });

  it('errors on an open phase in no step once every step has Items', () => {
    const milestone = milestoneOf(`## Steps

### Step: one · Status: TODO

- Items: \`backend/signup\`
`);

    expect(
      rulesOf(checkMilestoneUnscheduledPhases, milestone, SHARED_SLUG_PLANS),
    ).toEqual([['milestone/unscheduled-phase', 'error']]);
  });

  it('passes when every open phase is in a step and the rest are DONE or DROPPED', () => {
    const milestone = milestoneOf(`## Steps

### Step: one · Status: TODO

- Items: \`backend/signup\`, \`web/signup\`
`);
    const plans: MemberPlans = {
      ...SHARED_SLUG_PLANS,
      web: [
        phase(1, 'scaffold', { status: 'DROPPED (2026-11-12, merged)' }),
        phase(2, 'signup', {}),
      ],
    };

    expect(rulesOf(checkMilestoneUnscheduledPhases, milestone, plans)).toEqual(
      [],
    );
  });
});

describe('checkMilestoneNeedsMatchBlocks', () => {
  const step = (
    slug: string,
    needs: string,
  ) => `### Step: ${slug} · Status: TODO

Increment.

- Items: \`backend/${slug}\`
- Close: \`pnpm check\`
- Needs: ${needs}
`;
  const gates = `## Gates

- G1 · OPEN · decision · auth approach · blocks \`sign-up\`
- G2·CLOSED (2026-11-19, default taken)·spike·latency· blocks \`sign-up\`
- G3 · OPEN · human · device · blocks \`provision\`

`;

  it('passes a step whose Needs ids are exactly its blocking gates', () => {
    const milestone = milestoneOf(
      `${gates}## Steps\n\n${step('sign-up', 'G1, G2')}\n${step('provision', 'G3')}\n${step('skeleton', 'none')}`,
    );
    expect(rulesOf(checkMilestoneNeedsMatchBlocks, milestone, {})).toEqual([]);
  });

  it('errors on a Needs id whose gate blocks another step', () => {
    const milestone = milestoneOf(
      `${gates}## Steps\n\n${step('sign-up', 'G1,G2,G3')}\n${step('provision', 'G3')}`,
    );
    const { findings } = checkMilestoneNeedsMatchBlocks(FILE, milestone, {});
    expect(findings.map((finding) => finding.rule)).toEqual([
      'milestone/needs-blocks',
    ]);
    expect(findings[0]?.msg).toContain('G3 blocks `provision`');
  });

  it('errors once on a Needs id that no gate defines', () => {
    const milestone = milestoneOf(
      `${gates}## Steps\n\n${step('sign-up', 'G1, G2, G9')}\n${step('provision', 'G3')}`,
    );
    const plans: MemberPlans = {
      backend: [phase(1, 'sign-up', {}), phase(2, 'provision', {})],
    };
    const everyCheck = [
      checkMilestoneUnknownItems,
      checkMilestoneOpenGates,
      checkMilestoneNeedsMatchBlocks,
    ].flatMap((check) => check(FILE, milestone, plans).findings);
    expect(everyCheck).toHaveLength(1);
    expect(everyCheck[0]?.msg).toContain('no gate has that id');
  });

  it('errors on a blocking gate the Needs line omits', () => {
    const milestone = milestoneOf(
      `${gates}## Steps\n\n${step('sign-up', 'G1')}\n${step('provision', 'none')}`,
    );
    const { findings } = checkMilestoneNeedsMatchBlocks(FILE, milestone, {});
    expect(findings.map((finding) => finding.msg)).toEqual([
      expect.stringContaining('gate G2 blocks step `sign-up`'),
      expect.stringContaining('gate G3 blocks step `provision`'),
    ]);
  });

  it('skips a scope-line step even when a gate blocks it', () => {
    const milestone = milestoneOf(
      `${gates}## Steps\n\n### Step: sign-up · Status: TODO\n\nA user signs up.\n\n### Step: provision · Status: TODO\n\nA user claims a device.\n`,
    );
    expect(rulesOf(checkMilestoneNeedsMatchBlocks, milestone, {})).toEqual([]);
  });
});

describe('checkMilestoneBarRecorded', () => {
  const withLog = (log: string, status = 'IN PROGRESS'): Milestone =>
    parseMilestone(`${MEMBERS_TABLE.replace('IN PROGRESS', status)}\n${log}`);

  it.each([
    ['no Log section', ''],
    ['an empty Log section', '## Log\n\n'],
    [
      'a first line with no Bar clause',
      '## Log\n\n- 2026-11-19: scaffolded.\n',
    ],
    [
      'the template placeholder',
      '## Log\n\n- 2026-11-19: scaffolded. Bar: <the verdict sentence>.\n',
    ],
    ['an empty clause', '## Log\n\n- 2026-11-19: scaffolded. Bar:\n'],
    [
      'a Bar clause only on a later line',
      '## Log\n\n- 2026-11-19: scaffolded.\n- 2026-11-20: Bar: one phase.\n',
    ],
  ])('errors on %s', (_case, log) => {
    expect(rulesOf(checkMilestoneBarRecorded, withLog(log), {})).toEqual([
      ['milestone/bar-unrecorded', 'error'],
    ]);
  });

  it.each([
    '## Log\n\n- 2026-11-19: scaffolded. Bar: two members, shared contract, so a milestone.\n',
    '## Log\n\n- 2026-11-19: scaffolded. Bar:one plan would do.',
  ])('passes a real verdict', (log) => {
    expect(rulesOf(checkMilestoneBarRecorded, withLog(log), {})).toEqual([]);
  });

  it('exempts a DONE milestone with no clause', () => {
    expect(
      rulesOf(checkMilestoneBarRecorded, withLog('', 'DONE (2026-11-20)'), {}),
    ).toEqual([]);
  });
});

describe('the milestone checks over a milestone with nothing runnable', () => {
  const ALL_CHECKS: MilestoneCheck[] = [
    checkMilestoneUnknownItems,
    checkMilestoneDuplicatePhaseSlugs,
    checkMilestonePhaseInTwoSteps,
    checkMilestoneStepDoneEarly,
    checkMilestoneStepTodoLate,
    checkMilestoneOneOpenStep,
    checkMilestoneOpenGates,
    checkMilestoneNeedsMatchBlocks,
    checkMilestoneBarRecorded,
    checkMilestoneItemDomains,
    checkMilestoneHeldPathOverlap,
    checkMilestoneLiveItems,
    checkMilestoneResources,
    checkMilestoneOwnerItems,
    checkMilestoneContracts,
    checkMilestoneUnscheduledPhases,
    checkMilestoneHorizonWritten,
  ];
  const HORIZON_ERROR = ['milestone/horizon-unwritten', 'error'];

  it.each([
    ['zero steps', '## Steps\n', []],
    [
      'only scope lines',
      `## Steps

### Step: one · Status: TODO

A user signs up.

### Step: two · Status: TODO
`,
      [HORIZON_ERROR, HORIZON_ERROR],
    ],
  ])(
    'finds only the horizon errors on a milestone with %s',
    (_case, steps, expected) => {
      const milestone = milestoneOf(
        `${steps}\n## Log\n\n- 2026-11-19: scaffolded. Bar: two members share a contract.\n`,
      );

      const findings = ALL_CHECKS.flatMap(
        (check) => check(FILE, milestone, SHARED_SLUG_PLANS).findings,
      );

      expect(findings.map((finding) => [finding.rule, finding.level])).toEqual(
        expected,
      );
    },
  );
});

describe('formatGateLines', () => {
  const milestone = parseMilestone(`## Gates

- G1 · CLOSED (2026-11-19) · decision · auth approach · blocks \`sign-up\`
- G2 · OPEN · decision · billing · blocks \`checkout\`

## Steps

### Step: sign-up · Status: TODO
`);

  it('prints one line per gate blocking the step, with the state as parsed', () => {
    expect(formatGateLines(milestone, 'sign-up')).toEqual([
      'G1 · CLOSED · blocks sign-up',
    ]);
  });

  it('says so when no gate blocks the step', () => {
    expect(formatGateLines(milestone, 'launch')).toEqual([
      'no gates block launch',
    ]);
  });
});
