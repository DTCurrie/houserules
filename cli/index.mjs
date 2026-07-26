#!/usr/bin/env node
// claude-kit CLI entry point. Dispatches init | update | doctor.
//
// The CLI (this directory) may use npm dependencies; everything under payload/ is
// copied into target repos and must stay zero-dependency node builtins only.

import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version: KIT_VERSION } = require('../package.json');

const USAGE = `claude-kit ${KIT_VERSION} — portable Claude Code context-discipline kit

Usage:
  npx claude-kit init    [dir] [--dry-run] [--yes] [--modules=a,b,-c]
  npx claude-kit modules [dir] [--dry-run] [--yes] [--modules=a,b]
  npx claude-kit update  [dir] [--dry-run] [--force] [--next-steps]
  npx claude-kit doctor  [dir]
  npx claude-kit report  [dir]

Commands:
  init     Detect the repo, choose modules interactively, and install the kit
           into .claude/ (non-destructive; shows a full plan before writing).
  modules  List installed vs available modules and enable more after init
           (add-only). Interactive, or headless via --modules=<id,...>.
  update   Refresh kit-owned files to this kit version. Files you have edited
           are skipped with a warning (use --force to overwrite them).
  doctor   Validate the installation: config vs repo reality, hooks wired,
           kit files intact, changesets invocation story.
  report   Read-only transcript telemetry for this repo's sessions: per-session
           + rolled-up token tables (cache_read cost-weighted, not vanity).

Flags:
  --dry-run        Print the plan (or update/doctor report) without writing.
  --yes            Accept all defaults; no prompts (implied when not a TTY).
  --modules=LIST   Adjust the default module selection headlessly, e.g.
                   --modules=ledger,terse-style,-rename (additive; "-" removes).
  --force          update only: overwrite kit files that have local edits.
  --next-steps     update only: print the full post-install to-do list (summarized
                   by default — init and modules always print theirs).
  --version        Print the kit version.
  --help           This text.

Details: https://github.com/devintcurrie/claude-kit#readme
`;

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      modules: { type: 'string' },
      force: { type: 'boolean', default: false },
      'next-steps': { type: 'boolean', default: false },
      version: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.version) {
    console.log(KIT_VERSION);
    return 0;
  }

  const [command, dirArg] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return command ? 0 : values.help ? 0 : 1;
  }

  const targetDir = dirArg ?? process.cwd();
  const flags = {
    dryRun: values['dry-run'],
    yes: values.yes || !process.stdout.isTTY,
    modules: values.modules ?? '',
    force: values.force,
    nextSteps: values['next-steps'],
    kitVersion: KIT_VERSION,
  };

  switch (command) {
    case 'init': {
      const { init } = await import('./commands/init.mjs');
      return init(targetDir, flags);
    }
    case 'modules': {
      const { modules } = await import('./commands/modules.mjs');
      return modules(targetDir, flags);
    }
    case 'update': {
      const { update } = await import('./commands/update.mjs');
      return update(targetDir, flags);
    }
    case 'doctor': {
      const { doctor } = await import('./commands/doctor.mjs');
      return doctor(targetDir, flags);
    }
    case 'report': {
      const { report } = await import('./commands/report.mjs');
      return report(targetDir, flags);
    }
    default:
      console.error(`Unknown command "${command}".\n`);
      console.log(USAGE);
      return 1;
  }
}

main().then(
  (code) => process.exit(code ?? 0),
  (err) => {
    console.error(err?.stack ?? String(err));
    process.exit(1);
  },
);
