import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  Answers,
  ModuleDef,
  ModuleOptionChoice,
  ModuleRequirement,
} from '../index.js';

const answers: Answers = {
  moduleIds: ['core'],
  targets: [],
  seedChangesetConfig: false,
  moduleOptions: {},
};

describe('module requirement types', () => {
  it('ModuleRequirement is a bare id with an optional package', () => {
    const requirement: ModuleRequirement = { id: 'design' };

    expectTypeOf<ModuleRequirement>().toEqualTypeOf<{
      id: string;
      package?: string;
    }>();
    expect(requirement.package).toBeUndefined();
  });

  it('requires and uses are optional requirement lists', () => {
    const requires: ModuleDef['requires'] = [{ id: 'core' }];

    expectTypeOf<ModuleDef['requires']>().toEqualTypeOf<
      ModuleRequirement[] | undefined
    >();
    expectTypeOf<ModuleDef['uses']>().toEqualTypeOf<
      ModuleRequirement[] | undefined
    >();
    expect(requires).toEqual([{ id: 'core' }]);
  });

  it('an option choice carries optional requirements', () => {
    const choice: ModuleOptionChoice = {
      value: 'browser',
      label: 'Browser',
      requires: [{ id: 'design', package: '@houserules/plugin-design' }],
    };

    expectTypeOf<ModuleOptionChoice['requires']>().toEqualTypeOf<
      ModuleRequirement[] | undefined
    >();
    expect(choice.requires?.[0]?.package).toBe('@houserules/plugin-design');
  });

  it('skillTriggers maps Answers to lines', () => {
    const skillTriggers: NonNullable<ModuleDef['skillTriggers']> = () => [
      '- a trigger',
    ];

    expectTypeOf<
      NonNullable<ModuleDef['skillTriggers']>
    >().parameters.toEqualTypeOf<[Answers]>();
    expectTypeOf<
      NonNullable<ModuleDef['skillTriggers']>
    >().returns.toEqualTypeOf<string[]>();
    expect(skillTriggers(answers)).toEqual(['- a trigger']);
  });

  it('contributedSkillTriggers is an optional string list', () => {
    expectTypeOf<Answers['contributedSkillTriggers']>().toEqualTypeOf<
      string[] | undefined
    >();
    expect(answers.contributedSkillTriggers).toBeUndefined();
  });
});
