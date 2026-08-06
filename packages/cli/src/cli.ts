#!/usr/bin/env node
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Command, CommanderError } from 'commander';

import { KitConfigError } from './core/config.js';
import type { Flags } from './cli-contract.js';
import { EXIT } from './cli-contract.js';

const require = createRequire(import.meta.url);
const { version: KIT_VERSION } = require('../package.json') as {
  version: string;
};

interface GlobalOptions {
  cwd?: string;
  dryRun?: boolean;
}

interface CommandOptions {
  yes?: boolean;
  modules?: string;
  disable?: string;
  reconfigure?: string;
  moduleOption?: string[];
  fix?: boolean;
  prune?: boolean;
  force?: boolean;
  nextSteps?: boolean;
  json?: boolean;
}

/** Null until a subcommand runs, which tells "no command given" apart from "exited 0". */
let exitCode: number | null = null;

/**
 * The positional `[dir]` wins over `--cwd`. Both exist because every README example
 * and the dogfood script use the positional form, while `--cwd` is what a wrapper
 * script reaches for.
 */
function targetDir(dir: string | undefined, command: Command): string {
  const globals = command.optsWithGlobals<GlobalOptions>();
  return resolve(dir ?? globals.cwd ?? process.cwd());
}

function flagsFrom(options: CommandOptions, command: Command): Flags {
  const globals = command.optsWithGlobals<GlobalOptions>();
  return {
    dryRun: globals.dryRun ?? false,
    // A non-TTY cannot answer a prompt, so it implies --yes.
    yes: (options.yes ?? false) || !process.stdout.isTTY,
    modules: options.modules ?? '',
    disable: options.disable ?? '',
    reconfigure: options.reconfigure ?? '',
    moduleOption: options.moduleOption,
    fix: options.fix ?? false,
    prune: options.prune ?? false,
    force: options.force ?? false,
    nextSteps: options.nextSteps ?? false,
    json: options.json ?? false,
    kitVersion: KIT_VERSION,
  };
}

const program = new Command()
  .name('agent-kit')
  .description('portable Claude Code context-discipline kit')
  .version(KIT_VERSION, '-v, --version')
  .option('--cwd <dir>', 'target repo root (default: current directory)')
  .option('--dry-run', 'show what would change without writing')
  .showHelpAfterError()
  .exitOverride();

program
  .command('init')
  .description(
    'detect the repo, choose modules, and install the kit into .claude/',
  )
  .argument('[dir]', 'target repo root (default: current directory)')
  .option('--yes', 'accept all defaults; no prompts (implied when not a TTY)')
  .option(
    '--modules <list>',
    'adjust the default selection, e.g. ledger,output-prose,-rename ("-" removes)',
  )
  .option(
    '--module-option <id=values>',
    'set a module option, e.g. testing=typescript,javascript (repeatable)',
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
  )
  .action(
    async (
      dir: string | undefined,
      options: CommandOptions,
      command: Command,
    ) => {
      const { init } = await import('./commands/init.js');
      exitCode = await init(
        targetDir(dir, command),
        flagsFrom(options, command),
      );
    },
  );

program
  .command('modules')
  .description('list installed vs available modules; enable or disable them')
  .argument('[dir]', 'target repo root (default: current directory)')
  .option('--yes', 'accept all defaults; no prompts (implied when not a TTY)')
  .option('--modules <list>', 'enable these module ids headlessly')
  .option(
    '--disable <list>',
    'withdraw these module ids (prunes their files, unwires their settings)',
  )
  .option(
    '--reconfigure <list>',
    'revisit these installed module ids’ options (with --yes, pass --module-option)',
  )
  .option(
    '--module-option <id=values>',
    'set a module option, e.g. testing=typescript,javascript (repeatable)',
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
  )
  .option(
    '--force',
    'when disabling, also remove files you have edited locally',
  )
  .action(
    async (
      dir: string | undefined,
      options: CommandOptions,
      command: Command,
    ) => {
      const { modules } = await import('./commands/modules.js');
      exitCode = await modules(
        targetDir(dir, command),
        flagsFrom(options, command),
      );
    },
  );

program
  .command('update')
  .description(
    'refresh kit-owned files to this kit version, keeping your edits',
  )
  .argument('[dir]', 'target repo root (default: current directory)')
  .option('--force', 'overwrite kit files that have local edits')
  .option(
    '--next-steps',
    'print the full post-install to-do list (summarized by default)',
  )
  .action(
    async (
      dir: string | undefined,
      options: CommandOptions,
      command: Command,
    ) => {
      const { update } = await import('./commands/update.js');
      exitCode = await update(
        targetDir(dir, command),
        flagsFrom(options, command),
      );
    },
  );

program
  .command('doctor')
  .description(
    'validate the installation; exits 1 on drift, 2 on an invalid kit.config.json',
  )
  .argument('[dir]', 'target repo root (default: current directory)')
  .option('--json', 'machine-readable report on stdout')
  .option('--fix', 'reconcile the drift found (your edits are kept)')
  .option('--prune', 'with --fix, also delete orphaned kit files')
  .option('--force', 'with --fix, also overwrite files you have edited')
  .action(
    async (
      dir: string | undefined,
      options: CommandOptions,
      command: Command,
    ) => {
      if (options.prune && !options.fix) {
        command.error('error: --prune requires --fix');
      }
      if (options.force && !options.fix) {
        command.error('error: --force requires --fix');
      }
      const { doctor } = await import('./commands/doctor.js');
      exitCode = await doctor(
        targetDir(dir, command),
        flagsFrom(options, command),
      );
    },
  );

program
  .command('probe')
  .description(
    'load a plugin package through the real resolver and report what it contributes',
  )
  .argument('<path>', 'path to the plugin package, relative to the cwd')
  .option('--alias <name>', 'namespace to register the plugin under', 'probe')
  .action(async (path: string, options: { alias: string }) => {
    const { probe } = await import('./commands/probe.js');
    exitCode = await probe(resolve(path), options.alias);
  });

program
  .command('report')
  .description("transcript telemetry for this repo's sessions (read-only)")
  .argument('[dir]', 'target repo root (default: current directory)')
  .option('--json', 'machine-readable report on stdout')
  .action(
    async (
      dir: string | undefined,
      options: CommandOptions,
      command: Command,
    ) => {
      const { report } = await import('./commands/report.js');
      exitCode = await report(
        targetDir(dir, command),
        flagsFrom(options, command),
      );
    },
  );

program.addHelpText(
  'after',
  `
Exit codes:
  0  success (doctor: no problems)
  1  error, or doctor found a problem
  2  .claude/kit.config.json does not satisfy the schema

Details: https://github.com/DTCurrie/agent-kit#readme`,
);

try {
  await program.parseAsync();
  if (exitCode === null) {
    // Usage output belongs on stderr so CI logs do not mix help text into real
    // output. Only an explicit --help goes to stdout, which commander handles.
    program.outputHelp({ error: true });
    process.exit(EXIT.error);
  }
  process.exit(exitCode);
} catch (error) {
  if (error instanceof CommanderError) {
    // --help and --version report success. Parse failures already wrote to stderr.
    process.exit(error.exitCode === 0 ? EXIT.ok : EXIT.error);
  }
  if (error instanceof KitConfigError) {
    console.error(error.message);
    process.exit(EXIT.badConfig);
  }
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exit(EXIT.error);
}
