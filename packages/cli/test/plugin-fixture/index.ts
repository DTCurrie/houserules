import { definePlugin, hookFragment } from '@claude-kit/cli/plugin';
import type {
  Action,
  Answers,
  Ctx,
  ModuleDef,
  PluginApi,
} from '@claude-kit/cli/plugin';

interface FixtureConfig {
  note?: string;
}

function readConfig(config: unknown): FixtureConfig {
  if (config === undefined || config === null) return {};
  if (typeof config !== 'object') {
    throw new Error('plugin-fixture: config must be an object');
  }
  return config as FixtureConfig;
}

function buildCopyModule(api: PluginApi): ModuleDef {
  return {
    id: 'fixture-core',
    title: 'Fixture Core',
    group: 'optional',
    hint(): string {
      return `alias: ${api.alias}`;
    },
    defaultEnabled(): boolean {
      return true;
    },
    plan(_ctx: Ctx, _answers: Answers): Action[] {
      return [
        api.payload.script(
          'fixture-core',
          'fixture-script.mjs',
          'fixture copy action',
        ),
        api.payload.skill(
          'fixture-core',
          'fixture-skill',
          'fixture skill action',
        ),
        api.payload.agent(
          'fixture-core',
          'fixture-agent',
          'fixture agent action',
        ),
        api.payload.rule('fixture-core', 'fixture-rule', 'fixture body action'),
        api.payload.reference(
          'fixture-core',
          'fixture-reference',
          'fixture reference action',
        ),
        api.payload.template(
          'fixture-core',
          'fixture-template.md',
          'fixture template action',
        ),
        api.payload.file({
          module: 'fixture-core',
          srcRel: 'extra/fixture-file.txt',
          dest: '.claude/fixture-file.txt',
          reason: 'fixture file action',
        }),
      ];
    },
  };
}

function buildRawModule(api: PluginApi): ModuleDef {
  const fixtureConfig = readConfig(api.config);
  const note = fixtureConfig.note ?? 'no note configured';

  return {
    id: 'fixture-extra',
    title: 'Fixture Extra',
    group: 'optional',
    hint(): string {
      return 'fixture module covering write, seed, region, merge-settings, advise';
    },
    defaultEnabled(): boolean {
      return true;
    },
    plan(_ctx: Ctx, _answers: Answers): Action[] {
      return [
        {
          kind: 'write',
          module: 'fixture-extra',
          dest: '.claude/fixture-write.md',
          content: `Fixture write action for ${api.packageName}, alias ${api.alias}.\n`,
          reason: 'fixture write action',
        },
        {
          kind: 'seed',
          module: 'fixture-extra',
          dest: 'FIXTURE_SEED.md',
          content: `Fixture seed action. Note: ${note}.\n`,
          reason: 'fixture seed action',
        },
        {
          kind: 'region',
          module: 'fixture-extra',
          dest: 'CLAUDE.md',
          body: 'Fixture region body.',
          region: {
            id: 'fixture-extra',
            start: '<!-- fixture:start -->',
            end: '<!-- fixture:end -->',
            anchor: 'eof',
          },
          reason: 'fixture region action',
        },
        {
          kind: 'merge-settings',
          module: 'fixture-extra',
          fragment: hookFragment('Stop', null, 'fixture-script.mjs'),
        },
        {
          kind: 'advise',
          module: 'fixture-extra',
          text: `Fixture advise line from alias ${api.alias}.`,
        },
      ];
    },
  };
}

function buildOptionsModule(api: PluginApi): ModuleDef {
  const id = 'fixture-langs';
  return {
    id,
    title: 'Fixture Languages',
    group: 'optional',
    hint(): string {
      return 'fixture module exercising ModuleOptions';
    },
    defaultEnabled(): boolean {
      return true;
    },
    options: {
      prompt: 'Which fixture languages?',
      choices: [
        { value: 'alpha', label: 'Alpha' },
        { value: 'beta', label: 'Beta' },
      ],
      defaults: ['alpha'],
    },
    plan(_ctx: Ctx, answers: Answers): Action[] {
      // Its own namespaced key, which is why the factory is handed `api.alias`. A module
      // cannot know the namespace it was mounted under any other way.
      const chosen = answers.moduleOptions[`${api.alias}/${id}`] ?? [];
      return chosen.map((value) => ({
        kind: 'write',
        module: id,
        dest: `.claude/fixture-lang-${value}.md`,
        content: `Fixture language ${value}.\n`,
        reason: `fixture option ${value}`,
      }));
    },
  };
}

export default definePlugin((api: PluginApi): ModuleDef[] => [
  buildCopyModule(api),
  buildRawModule(api),
  buildOptionsModule(api),
]);
