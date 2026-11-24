#!/usr/bin/env node
/**
 * Builds this fixture's `repo/`: the houserules tree at the commit before the plan-project stop
 * rule, from `git archive`, with `seed/` copied over it. `seed/` holds the `ignored-payload` plan
 * as it stood when the first recorded prompt ran, since `.claude/plans/` is never committed.
 * Run it once before any `run.mjs --fixture` call on this fixture. `repo/` is gitignored.
 *
 *   node make-repo.mjs [--rev <rev>] [--source <git dir>] [--dest <dir>]
 *
 * `--rev` defaults to the pre-rule commit, `--source` to the checkout this file sits in, and
 * `--dest` to `repo/` beside this file. The source needs the full history, not a shallow clone.
 * An existing `--dest` is refused and left untouched. Remove it yourself to rebuild.
 *
 * Exit codes: 0 when the repo was built, 1 when `git archive` or `tar` failed, 2 on a usage
 * error or an existing `--dest`.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
/** The parent of the commit that added "Grounding stops at the first write". */
const PRE_RULE_REV = 'b66b3c49dc8c8bb19f6fe801f89a1ae06bb62b57';
const CHECKOUT_ROOT = resolve(FIXTURE_DIR, '..', '..', '..', '..');
const SEED_DIR = join(FIXTURE_DIR, 'seed');
const BYTES_PER_MEGABYTE = 1024 * 1024;
// The archive of the whole tree runs to about 5 MB. Allow 512 MB, far past the default 1 MB.
const ARCHIVE_MAX_BYTES = 512 * BYTES_PER_MEGABYTE;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        rev: { type: 'string', default: PRE_RULE_REV },
        source: { type: 'string', default: CHECKOUT_ROOT },
        dest: { type: 'string', default: join(FIXTURE_DIR, 'repo') },
      },
    }));
  } catch (error) {
    console.error(error.message);
    return EXIT_USAGE;
  }

  const dest = resolve(values.dest);
  if (existsSync(dest)) {
    console.error(`${dest} already exists. Remove it to rebuild.`);
    return EXIT_USAGE;
  }

  const archive = spawnSync(
    'git',
    ['-C', values.source, 'archive', '--format=tar', values.rev],
    { maxBuffer: ARCHIVE_MAX_BYTES },
  );
  if (archive.status !== 0) {
    console.error(
      `git archive ${values.rev} in ${values.source} exited ${archive.status}: ${archive.stderr}`,
    );
    return EXIT_FAILED;
  }

  mkdirSync(dest, { recursive: true });
  const extract = spawnSync('tar', ['-x', '-C', dest], {
    input: archive.stdout,
  });
  if (extract.status !== 0) {
    console.error(
      `tar -x into ${dest} exited ${extract.status}: ${extract.stderr}`,
    );
    return EXIT_FAILED;
  }
  cpSync(SEED_DIR, dest, { recursive: true });
  console.log(`built ${dest} from ${values.rev}`);
  return 0;
}

process.exitCode = main();
