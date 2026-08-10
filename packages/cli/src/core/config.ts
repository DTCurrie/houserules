import { z } from 'zod';
import type { Simplify } from 'type-fest';

/** A package-manager invocation block: how to run a script in one package. */
const runnerBlock = z.strictObject({
  runner: z.string().min(1).describe('Package manager binary, e.g. "pnpm".'),
  filterFlag: z
    .string()
    .describe(
      'Workspace filter flag, e.g. "--filter". Empty for a single-package repo.',
    ),
  runScriptPrefix: z
    .array(z.string())
    .describe('Argv between the runner and the script name, e.g. ["run"].'),
  commands: z
    .array(z.string())
    .describe('package.json scripts to run, in order.'),
});

const targetSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .describe('Kebab short name; used in generated filenames.'),
  prefix: z
    .string()
    .min(1)
    .describe('Uppercase backlog-id prefix, e.g. "CORE".'),
  packageName: z
    .string()
    .describe('package.json name, or "." for a rootless repo.'),
  pathPrefix: z
    .string()
    .describe(
      'Repo-relative dir with a trailing slash; "" for a single-package repo.',
    ),
  sourcePath: z.string().describe("Where this target's source lives."),
  label: z.string().describe('Human label, e.g. "Core".'),
  fixCommands: z
    .array(z.string())
    .nullable()
    .optional()
    .describe('Per-target override of fix.commands. Real repos diverge.'),
  verifyCommands: z
    .array(z.string())
    .nullable()
    .optional()
    .describe('Per-target override of verify.commands.'),
  changelogPath: z.string().optional().describe('Ledger module only.'),
  logPath: z.string().optional().describe('Ledger module only.'),
  regen: z
    .strictObject({
      sourceGlob: z.string(),
      command: z.string(),
    })
    .optional()
    .describe(
      'Regen module: re-run `command` when a file matching `sourceGlob` is edited.',
    ),
});

/**
 * One plugin the kit loads. `config` is the deliberate hole in an otherwise strict schema:
 * the kit validates that a plugin was declared correctly and never looks inside what that
 * plugin was configured with. Each plugin validates its own slice, because only it knows the
 * shape, and a plugin that silently accepts a typo'd key is a plugin whose config does nothing.
 */
const pluginEntrySchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .describe(
      'npm package name, or a repo-relative path to a directory holding a package.json.',
    ),
  alias: z
    .string()
    .min(1)
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      'must be lowercase letters, digits, and dashes, starting with a letter or digit',
    )
    .describe(
      'Id namespace for this plugin\'s modules. A module `prose-voice` under alias `voice` is selected as "voice/prose-voice".',
    ),
  config: z
    .unknown()
    .optional()
    .describe('Passed to the plugin verbatim. The kit never reads inside it.'),
});

/**
 * The strict validator for `.claude/kit.config.json`. An unknown key is a typo the user
 * wants told about, which is the whole reason this schema exists.
 *
 * Defaults deliberately live in the payload (`GUARD_DEFAULTS`, `READ_GUARD_DEFAULTS` in
 * `scripts/lib/kit-config.mjs`), not here. This schema answers "is this valid", not
 * "what does it mean when absent". Duplicating the defaults would let the CLI reader and
 * the payload reader drift, and the hooks are the ones that have to cope with absence.
 */
export const KitConfigSchema = z.strictObject({
  // Documentation keys the shipped example carries. Declared so a strict parse
  // does not reject the very file we tell people to copy.
  _help: z.string().optional(),
  _notes: z.record(z.string(), z.string()).optional(),

  $schema: z.string().optional(),
  version: z.literal(2).describe('Config schema version.'),
  packageManager: z.string().min(1),

  fix: runnerBlock
    .extend({
      onSubagentStop: z
        .boolean()
        .optional()
        .describe(
          'Run the fixer when a SUBAGENT stops. Off by default: parallel workers would each fix every package at once.',
        ),
      // Read by lint-format-fix.mts. Like verify.baseBranch, this is a key the
      // scripts genuinely consume, so a strictObject that omitted it would reject a
      // working config.
      commandExtensions: z
        .record(z.string(), z.array(z.string()))
        .optional()
        .describe(
          'Per-fix-command file extensions, e.g. {"lint:fix": ["ts","tsx"]}. Narrows which changed files trigger which fixer.',
        ),
    })
    .optional(),
  verify: runnerBlock
    .extend({
      // verify-changed.mts reads this key, so a strictObject omitting it would reject a
      // documented, working config.
      baseBranch: z
        .string()
        .optional()
        .describe(
          'Branch the changed-file diff is taken against. Defaults to changesets.baseBranch, then "main".',
        ),
    })
    .optional()
    .describe('Only present when the verify-changed module is enabled.'),

  lintableExtensions: z.array(z.string()).optional(),
  generatedFilePattern: z
    .string()
    .optional()
    .describe('Regex source; files matching it are never auto-fixed.'),

  guard: z
    .strictObject({
      gitCommit: z.boolean().optional(),
      gitPush: z.boolean().optional(),
      gitStash: z.boolean().optional(),
      prCreate: z.boolean().optional(),
      custom: z
        .array(z.strictObject({ pattern: z.string(), message: z.string() }))
        .optional(),
    })
    .optional(),

  changesets: z
    .strictObject({
      enabled: z.boolean().optional(),
      stopCheck: z.boolean().optional(),
      baseBranch: z.string().optional(),
    })
    .optional(),

  ledger: z.strictObject({ enabled: z.boolean().optional() }).optional(),

  decisions: z.strictObject({ enabled: z.boolean().optional() }).optional(),

  projects: z
    .strictObject({
      autoSync: z
        .boolean()
        .optional()
        .describe(
          'Set false to forbid ledger syncing repo-wide. True only permits it: a push still needs a local .claude/ledgers/.projects.json, which only `bootstrap` writes, and maintain or admin on the repository.',
        ),
    })
    .optional()
    .describe(
      "Read at runtime by the projects plugin's scripts. Top level rather than inside its `plugins[].config` entry, because a payload script does not know the alias its own plugin was declared under, so it cannot find that entry.",
    ),

  ledgers: z
    .strictObject({
      dir: z
        .string()
        .optional()
        .describe(
          'Where the backlog and decision ledgers live, relative to the repo root. Holds the `.jsonl` logs and the markdown rendered from them. The whole directory is gitignored. Defaults to `.claude/ledgers`. One directory per repo: a monorepo distinguishes areas by filename, such as `studio.BACKLOG.md`, not by nesting.',
        ),
    })
    .optional(),

  claudeMd: z
    .strictObject({
      managed: z
        .boolean()
        .optional()
        .describe(
          'Let the kit maintain its marked block in CLAUDE.md. Set false to opt out; the kit then never touches the file.',
        ),
    })
    .optional(),

  readGuard: z
    .strictObject({
      enabled: z.boolean().optional(),
      maxBytes: z.number().int().positive().optional(),
      denyGlobs: z.array(z.string()).optional(),
    })
    .optional(),

  scripts: z
    .strictObject({
      commit: z
        .boolean()
        .optional()
        .describe(
          'Keep .claude/scripts/ committed instead of gitignored. Off by default: the scripts are build output, refreshed by `npx agent-kit update`.',
        ),
    })
    .optional(),

  plugins: z
    .array(pluginEntrySchema)
    .optional()
    .describe('Plugins contributing extra modules, resolved in this order.'),

  moduleOptions: z
    .record(z.string(), z.array(z.string()))
    .optional()
    .describe(
      'Per-module option selections, keyed by module id. Persisted so update and doctor never have to ask again.',
    ),

  targets: z.array(targetSchema).describe('The packages/areas the kit tracks.'),
});

/** The validated shape of `.claude/kit.config.json`. */
export type KitConfig = Simplify<z.infer<typeof KitConfigSchema>>;
export type KitConfigTarget = Simplify<z.infer<typeof targetSchema>>;

/**
 * The published JSON Schema, which powers editor IntelliSense via `$schema`.
 * `io: "input"` so optional-with-default fields stay optional. That is what a
 * hand-written config looks like.
 */
export function buildJsonSchema(): Record<string, unknown> {
  const { $schema, ...body } = z.toJSONSchema(KitConfigSchema, { io: 'input' });
  return {
    $schema,
    $id: 'https://github.com/DTCurrie/agent-kit/blob/main/schema/kit.config.schema.json',
    title: 'agent-kit config',
    description:
      'Per-repo configuration for agent-kit (.claude/kit.config.json).',
    ...body,
  };
}

/** Sections whose unknown keys are not "fields": the message names what they hold. */
const UNKNOWN_KEY_NOUNS: Record<string, string> = {
  guard: 'guard switch',
  changesets: 'changesets setting',
  readGuard: 'read-guard setting',
  scripts: 'scripts setting',
};

function problemsFrom(error: z.ZodError): string[] {
  return error.issues.flatMap((issue) => {
    const path = issue.path.join('.');
    if (issue.code === 'unrecognized_keys') {
      const noun = UNKNOWN_KEY_NOUNS[path] ?? 'field';
      const prefix = path === '' ? '' : `${path}.`;
      return issue.keys.map((key) => `${prefix}${key} is not a known ${noun}`);
    }
    return [path === '' ? issue.message : `${path} ${issue.message}`];
  });
}

export class KitConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[], cause?: unknown) {
    super(
      `Invalid .claude/kit.config.json:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'KitConfigError';
    this.problems = problems;
  }
}

/** @throws KitConfigError with one entry per problem. */
export function parseKitConfig(raw: string): KitConfig {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new KitConfigError(
      [`not valid JSON: ${(error as Error).message}`],
      error,
    );
  }
  const result = KitConfigSchema.safeParse(data, {
    // Only the callback sees `input`, so a missing field can be told apart from a
    // wrong-typed one here but not from the issue list afterwards.
    error: (issue) =>
      issue.code === 'invalid_type' && issue.input === undefined
        ? 'is required'
        : undefined,
  });
  if (!result.success) throw new KitConfigError(problemsFrom(result.error));
  return result.data;
}

/** Validation that never throws. For doctor, which reports rather than aborts. */
export function validateKitConfig(raw: string): string[] {
  try {
    parseKitConfig(raw);
    return [];
  } catch (error) {
    if (error instanceof KitConfigError) return error.problems;
    throw error;
  }
}
