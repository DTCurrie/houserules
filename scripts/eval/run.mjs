#!/usr/bin/env node
/**
 * Run the orchestrate-report behavioral check: assemble fixture samples, run headless
 * `claude -p` sessions on them under a spend ledger, and judge five payload claims.
 *
 * Command:
 *   node scripts/eval/run.mjs [--work <dir>] [--rev <rev>] [--per-run <usd>]
 *   node scripts/eval/run.mjs --paid --api-key-file <file> --budget <usd> --per-run <usd>
 *     --margin <ratio> --out <dir> (--preflight | [--samples <n>] [--no-slug])
 *     [--work <dir>] [--rev <rev>] [--timeout-min <minutes>]
 *   node scripts/eval/run.mjs --verdict-only --out <dir>
 *   node scripts/eval/run.mjs --fixture <dir> --arm <name> [--paid ... --samples <n>]
 *   node scripts/eval/run.mjs --fixture <dir> --arm <name> --sample <k> [--paid --api-key-file
 *     <file> --per-run <usd> --margin <ratio> --out <dir>]
 *
 * Options:
 *   --paid          Start real sessions. Without it the run is free: it builds the CLI,
 *                   assembles `sample-1`, runs its `plan-lint`, prints the child command, and
 *                   writes nothing under `--out`.
 *   --preflight     With `--paid`, run the two haiku probes in place of samples. Requires
 *                   `--per-run 0.02`, the cap probe (b) must reach.
 *   --verdict-only  Judge the sessions already in `--out`. Takes no `--work` and never touches
 *                   the ledger.
 *   --samples       Valid named-plan samples `--out` should hold (default 0). Only the missing
 *                   ones start.
 *   --no-slug       Also start the no-slug session, unless the ledger already holds one.
 *   --budget        Dollars the ledger may reach. Required with `--paid`.
 *   --per-run       Dollar cap per session, passed as `--max-budget-usd`. Required with `--paid`.
 *   --margin        Overshoot ratio the meter adds to each cap. Required with `--paid`.
 *   --work          Where samples are assembled (default `houserules-eval` under the OS temp
 *                   directory). A `scratchpad` or `.artifact-work` segment is refused.
 *   --out           Where session artifacts, `spend.jsonl`, and `verdict.json` go.
 *   --rev           Revision whose CLI installs into each sample (default `HEAD`).
 *   --timeout-min   Minutes before a session's process group is killed (default 20).
 *   --api-key-file  File holding the API key each paid session bills. Required with `--paid`.
 *                   Refused when missing, empty, or readable by group or others.
 *   --fixture       A fixture directory holding `eval.json` and `repo/`. Samples are built from
 *                   `repo/` with the modules, plugins, and model `eval.json` names, and judged
 *                   by its `validityAgent`. Requires `--arm`. Refused with `--preflight`,
 *                   `--no-slug`, or `--verdict-only`. Skips plan-lint and `verdict.json`.
 *   --arm           The `eval.json` arm to run: its prompt, its overlay over `.claude/`, and its
 *                   `model` when set. Artifacts go to `<out>/<arm>/sample-<k>/`, and `--samples`
 *                   counts only that arm's valid samples. Requires `--fixture`.
 *   --sample        Run exactly sample `<k>` of `--arm` into `<out>/<arm>/sample-<k>/`. Requires
 *                   `--fixture` and `--arm`. Refused with `--samples`, `--budget`, `--no-slug`,
 *                   `--preflight`, or `--verdict-only`, and when `<k>` is not a positive integer.
 *                   Under `--paid` it takes no `--budget`: it meters its one session against
 *                   `--per-run` times one plus `--margin` over `--out`'s own ledger, and is
 *                   refused when `<out>/<arm>/sample-<k>/` exists. A free run numbers the
 *                   assembled sample `<k>`.
 *
 * `eval.json` may set `network` to a boolean (default false). Unless true, the child runs with
 * `--disallowedTools WebFetch,WebSearch` and a `--settings` sandbox that blocks network access
 * from Bash and fails the session when the platform cannot sandbox.
 *
 * Environment:
 *   HOUSERULES_EVAL_CLI  A prebuilt `cli.js` to install with in place of building `--rev`. The
 *                        run then records no commit.
 *
 * Exit codes:
 *   0  the free dry run passed, the preflight passed, every claim reads PASS, or under
 *      `--fixture` every session the run started finished.
 *   1  `plan-lint` failed, a preflight check failed, or a claim reads FAIL.
 *   2  the verdict is incomplete, or the run could not start: a bad flag, a refused path or key
 *      file, a held lock, a failed build, a session that could not spawn, a preflight probe
 *      the meter refused, or under `--fixture` an arm sample the meter refused.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
  assembleSample,
  buildCli,
  readLeftTree,
  refuseWorkPath,
  runPlanLint,
} from './assemble.mjs';
import {
  assembleArmSample,
  copyCollect,
  exitOverlayHashes,
  judgeArmValidity,
  loadArmFixture,
} from './fixture-arm.mjs';
import { childArgv, childEnv, claudeVersion, runSession } from './child.mjs';
import {
  CLAIM_IDS,
  NO_SLUG_PROMPT,
  RUN_JSON,
  SAMPLE_MODEL,
  SAMPLE_PROMPT,
  STREAM,
  TRANSCRIPTS,
  VERDICT,
  armSessionDir,
  sessionDir,
  sessionDirName,
} from './layout.mjs';
import {
  readLedger,
  requirePaidFlags,
  runMetered,
  withLock,
} from './meter.mjs';
import { judgeValidity, loadSample, verdict } from './orchestrate-report.mjs';
import {
  PROBE_A_PROMPT,
  PROBE_B_PROMPT,
  PROBE_CAP_USD,
  judgeProbeA,
  judgeProbeB,
  manifestHashes,
  pathWithoutHouserules,
  priceTranscripts,
} from './preflight.mjs';

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_NOT_STARTED = 2;
const DEFAULT_REV = 'HEAD';
const DEFAULT_TIMEOUT_MINUTES = 20;
const DEFAULT_SAMPLES = 0;
/** The cap the free dry run prints when no `--per-run` is given: the plan's opus sample cap. */
const DRY_RUN_PER_RUN = 3;
const PROBE_MODEL = 'haiku';
/** `--tools ""` gives probe (a) no tools, so only SessionStart can write the tree. */
const NO_TOOLS = '';
/**
 * The `apiKeySource` a stream's `system` init record shows when the session billed the API key
 * from `ANTHROPIC_API_KEY`. Confirmed against the first real probe stream.
 */
const API_KEY_SOURCE = 'ANTHROPIC_API_KEY';
/** Recorded as `run.json` `commit` when `HOUSERULES_EVAL_CLI` replaced the build. */
const PREBUILT_COMMIT = 'prebuilt';
/** Group and other permission bits. A key file with any of them set is refused. */
const SHARED_MODE_BITS = 0o077;
/** Every permission bit, masked from a file mode to print it. */
const ALL_MODE_BITS = 0o777;
const OCTAL = 8;
const SAMPLE_DIR = /^sample-(\d+)$/;
const SHELL_SAFE = /^[\w@%+=:,./-]+$/;
/** Characters a double-quoted shell word cannot hold on one line, so `$'...'` quoting carries them. */
const LINE_BREAKING = /[\n\r\t]/;
const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A flag or file that stops the run before any build or session. */
class UsageError extends Error {}

/**
 * @param {string | undefined} text
 * @returns {number | undefined} `undefined` when the flag is absent, `NaN` when it is no number.
 */
function numberFlag(text) {
  return text === undefined ? undefined : Number(text);
}

/**
 * @param {string | undefined} text
 * @returns {number}
 */
function parseSamples(text) {
  if (text === undefined) return DEFAULT_SAMPLES;
  const samples = Number(text);
  if (Number.isInteger(samples) && samples >= 0) return samples;
  throw new UsageError(
    `--samples must be a non-negative integer, got "${text}"`,
  );
}

/**
 * @param {string | undefined} text
 * @returns {number | undefined} `undefined` when the flag is absent.
 */
function parseSample(text) {
  if (text === undefined) return undefined;
  const sample = Number(text);
  if (Number.isInteger(sample) && sample >= 1) return sample;
  throw new UsageError(`--sample must be a positive integer, got "${text}"`);
}

/**
 * @param {string | undefined} text
 * @returns {number}
 */
function parseTimeoutMinutes(text) {
  if (text === undefined) return DEFAULT_TIMEOUT_MINUTES;
  const minutes = Number(text);
  if (Number.isFinite(minutes) && minutes > 0) return minutes;
  throw new UsageError(
    `--timeout-min must be a positive number, got "${text}"`,
  );
}

/**
 * Turns argv into run options. Throws `UsageError` on an unknown flag or a bad value.
 *
 * @param {string[]} argv
 */
function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      paid: { type: 'boolean', default: false },
      preflight: { type: 'boolean', default: false },
      'verdict-only': { type: 'boolean', default: false },
      samples: { type: 'string' },
      sample: { type: 'string' },
      'no-slug': { type: 'boolean', default: false },
      budget: { type: 'string' },
      'per-run': { type: 'string' },
      margin: { type: 'string' },
      work: { type: 'string' },
      out: { type: 'string' },
      rev: { type: 'string', default: DEFAULT_REV },
      'timeout-min': { type: 'string' },
      'api-key-file': { type: 'string' },
      fixture: { type: 'string' },
      arm: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    isPaid: values.paid,
    isPreflight: values.preflight,
    isVerdictOnly: values['verdict-only'],
    samples: parseSamples(values.samples),
    isSamplesGiven: values.samples !== undefined,
    sample: parseSample(values.sample),
    hasNoSlug: values['no-slug'],
    budget: numberFlag(values.budget),
    perRun: numberFlag(values['per-run']),
    margin: numberFlag(values.margin),
    work: values.work,
    out: values.out,
    rev: values.rev,
    timeoutMinutes: parseTimeoutMinutes(values['timeout-min']),
    apiKeyFile: values['api-key-file'],
    fixture: values.fixture,
    arm: values.arm,
  };
}

/**
 * Reads and trims the API key. Every refusal names the path, never the content.
 *
 * @param {string | undefined} path
 * @returns {string}
 */
function readApiKey(path) {
  if (path === undefined)
    throw new UsageError('--paid requires --api-key-file');
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new UsageError(`--api-key-file ${path} does not exist`);
  }
  if (!stat.isFile())
    throw new UsageError(`--api-key-file ${path} is not a file`);
  if (stat.mode & SHARED_MODE_BITS) {
    throw new UsageError(
      `--api-key-file ${path} has mode ${(stat.mode & ALL_MODE_BITS).toString(OCTAL)}, readable beyond its owner; chmod 600 it`,
    );
  }
  const key = readFileSync(path, 'utf8').trim();
  if (key === '') throw new UsageError(`--api-key-file ${path} is empty`);
  return key;
}

/**
 * Refuses `--sample` without `--fixture` and `--arm`, or beside a flag that sizes or replaces a
 * multi-sample run.
 *
 * @param {ReturnType<typeof parseOptions>} options
 */
function refuseSampleFlags(options) {
  if (options.fixture === undefined || options.arm === undefined)
    throw new UsageError('--sample requires --fixture and --arm');
  if (options.isSamplesGiven)
    throw new UsageError('--sample takes no --samples');
  if (options.budget !== undefined)
    throw new UsageError(
      '--sample takes no --budget, it meters against --per-run and --margin',
    );
  if (options.hasNoSlug || options.isPreflight || options.isVerdictOnly)
    throw new UsageError(
      '--sample takes no --no-slug, --preflight, or --verdict-only',
    );
}

/**
 * Refuses `--arm` without `--fixture`, and `--fixture` without `--arm` or beside a flag only the
 * orchestrate-report check takes.
 *
 * @param {ReturnType<typeof parseOptions>} options
 */
function refuseFixtureFlags(options) {
  if (options.sample !== undefined) refuseSampleFlags(options);
  if (options.fixture === undefined) {
    if (options.arm !== undefined)
      throw new UsageError('--arm requires --fixture');
    return;
  }
  if (options.isPreflight || options.hasNoSlug || options.isVerdictOnly) {
    throw new UsageError(
      '--fixture takes no --preflight, --no-slug, or --verdict-only',
    );
  }
  if (options.arm === undefined)
    throw new UsageError('--fixture requires --arm');
}

/**
 * Refuses a paid `--sample` whose directory already holds artifacts.
 *
 * @param {ReturnType<typeof parseOptions>} options
 * @param {import('./fixture-arm.mjs').ArmFixture} fixture
 */
function refuseExistingSample(options, fixture) {
  if (options.out === undefined) return;
  const dir = armSessionDir(resolve(options.out), {
    arm: fixture.arm,
    sample: options.sample,
  });
  if (existsSync(dir))
    throw new UsageError(`--sample ${options.sample}: ${dir} already exists`);
}

/**
 * Checks every flag combination and file the run needs, before any build or session.
 *
 * @param {ReturnType<typeof parseOptions>} options
 * @returns {{ work: string, apiKey: string | null, fixture: import('./fixture-arm.mjs').ArmFixture | null }}
 */
function refuseBeforeStart(options) {
  refuseFixtureFlags(options);
  if (options.isVerdictOnly) {
    if (options.work !== undefined)
      throw new UsageError('--verdict-only takes no --work');
    if (options.isPaid || options.isPreflight || options.hasNoSlug) {
      throw new UsageError(
        '--verdict-only takes no --paid, --preflight, or --no-slug',
      );
    }
    if (options.out === undefined)
      throw new UsageError('--verdict-only requires --out');
    return { work: '', apiKey: null, fixture: null };
  }
  const work = resolve(options.work ?? join(tmpdir(), 'houserules-eval'));
  refuseWorkPath(work);
  const fixture =
    options.fixture === undefined
      ? null
      : loadArmFixture(options.fixture, options.arm);
  if (!options.isPaid) {
    if (options.isPreflight || options.hasNoSlug || options.samples > 0) {
      throw new UsageError(
        '--preflight, --samples, and --no-slug require --paid',
      );
    }
    return { work, apiKey: null, fixture };
  }
  if (options.sample !== undefined) {
    refuseExistingSample(options, fixture);
    // `--sample` takes no `--budget`, so only `--per-run` and `--margin` are checked here.
    requirePaidFlags({ ...options, budget: 0 });
    options.budget = options.perRun * (1 + options.margin);
  }
  requirePaidFlags(options);
  if (options.isPreflight && options.perRun !== PROBE_CAP_USD) {
    throw new UsageError(
      `--preflight requires --per-run ${PROBE_CAP_USD}, the cap probe (b) must reach, got ${options.perRun}`,
    );
  }
  const apiKey = readApiKey(options.apiKeyFile);
  if (options.out === undefined) throw new UsageError('--paid requires --out');
  return { work, apiKey, fixture };
}

/**
 * A directory-safe timestamp, to the millisecond, so two runs on one `--work` never share a
 * sample root.
 *
 * @returns {string}
 */
function makeStamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .replace('.', '-')
    .replace('Z', '');
}

/**
 * The built CLI: `HOUSERULES_EVAL_CLI` when set, else `buildCli` at `rev`.
 *
 * @param {string} rev
 * @returns {{ commit: string, cliPath: string }}
 */
function resolveCli(rev) {
  const prebuilt = process.env.HOUSERULES_EVAL_CLI;
  if (prebuilt) return { commit: PREBUILT_COMMIT, cliPath: resolve(prebuilt) };
  return buildCli({ rev, repoDir: REPO_DIR });
}

/** @param {string} arg */
function shellQuote(arg) {
  if (SHELL_SAFE.test(arg)) return arg;
  if (LINE_BREAKING.test(arg)) {
    const escaped = arg
      .replace(/[\\']/g, (char) => `\\${char}`)
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
    return `$'${escaped}'`;
  }
  return `"${arg.replace(/[\\"$`]/g, (char) => `\\${char}`)}"`;
}

/**
 * The free default: assemble `sample-1`, run its `plan-lint`, and print the child command.
 *
 * @param {ReturnType<typeof parseOptions>} options
 * @param {string} work
 * @returns {number}
 */
function dryRun(options, work) {
  const { cliPath } = resolveCli(options.rev);
  const { root } = assembleSample({
    cliPath,
    work,
    stamp: makeStamp(),
    key: { sample: 1 },
  });
  const lint = runPlanLint(root);
  if (lint.status !== 0) {
    console.error(
      `plan-lint exited ${lint.status} in ${root}:\n${lint.output}`,
    );
    return EXIT_FAILED;
  }
  const argv = childArgv({
    prompt: SAMPLE_PROMPT,
    model: SAMPLE_MODEL,
    perRun: options.perRun ?? DRY_RUN_PER_RUN,
  });
  console.log(`sample root ${root}`);
  console.log(['claude', ...argv].map(shellQuote).join(' '));
  return EXIT_OK;
}

/**
 * The free default under `--fixture`: assemble the arm's `sample-1` and print the child
 * command. It runs no plan-lint, since a fixture carries no plan.
 *
 * @param {ReturnType<typeof parseOptions>} options
 * @param {string} work
 * @param {import('./fixture-arm.mjs').ArmFixture} fixture
 * @returns {number}
 */
function fixtureDryRun(options, work, fixture) {
  const { cliPath } = resolveCli(options.rev);
  const { root } = assembleArmSample({
    fixture,
    cliPath,
    work,
    stamp: makeStamp(),
    sample: options.sample ?? 1,
  });
  const argv = childArgv({
    prompt: fixture.prompt,
    model: fixture.model,
    perRun: options.perRun ?? DRY_RUN_PER_RUN,
    isNetworkAllowed: fixture.isNetworkAllowed,
  });
  console.log(`sample root ${root}`);
  console.log(['claude', ...argv].map(shellQuote).join(' '));
  return EXIT_OK;
}

/**
 * The `apiKeySource` of a stream's `system` init record, or null.
 *
 * @param {string} streamPath
 * @returns {string | null}
 */
function readApiKeySource(streamPath) {
  if (!existsSync(streamPath)) return null;
  for (const line of readFileSync(streamPath, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type === 'system' && event.subtype === 'init') {
      return typeof event.apiKeySource === 'string' ? event.apiKeySource : null;
    }
  }
  return null;
}

/**
 * Everything one paid invocation shares across its sessions.
 *
 * @typedef {object} PaidContext
 * @property {ReturnType<typeof parseOptions>} options
 * @property {string} work
 * @property {string} out
 * @property {string} stamp
 * @property {string} commit
 * @property {string} cliPath
 * @property {string} version
 * @property {NodeJS.ProcessEnv} env The child environment, API key included.
 * @property {import('./fixture-arm.mjs').ArmFixture | null} fixture
 */

/**
 * @typedef {object} SessionSpec
 * @property {import('./layout.mjs').SessionKey} key
 * @property {string} prompt
 * @property {string} model
 * @property {string} [tools]
 */

/**
 * @typedef {{ root: string, decoyHashes: Record<string, string> }} AssembledSample
 */

/**
 * @param {PaidContext} context
 * @param {SessionSpec} spec
 * @returns {AssembledSample}
 */
function assembleForSpec(context, spec) {
  return assembleSample({
    cliPath: context.cliPath,
    work: context.work,
    stamp: context.stamp,
    key: spec.key,
  });
}

/**
 * Writes `run.json` beside a finished session's artifacts.
 *
 * @param {object} details
 * @param {PaidContext} details.context
 * @param {SessionSpec} details.spec
 * @param {AssembledSample} details.assembled
 * @param {Awaited<ReturnType<typeof runSession>>} details.session
 * @param {string} details.outDir
 * @param {string | null} details.apiKeySource
 */
function writeRunRecord(details) {
  const { context, spec, assembled, session, outDir, apiKeySource } = details;
  const record = {
    ...spec.key,
    claudeVersion: context.version,
    commit: context.commit,
    stamp: context.stamp,
    root: assembled.root,
    prompt: spec.prompt,
    exitCode: session.exitCode,
    timedOut: session.timedOut,
    sessionId: session.sessionId,
    leftTree: readLeftTree(assembled.root, assembled.decoyHashes),
    apiKeySource,
  };
  writeFileSync(join(outDir, RUN_JSON), `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Runs the child in an assembled sample, then records it.
 *
 * @param {PaidContext} context
 * @param {SessionSpec} spec
 * @param {AssembledSample} assembled
 * @returns {Promise<{ sessionId: string | null, resultEvent: object | null, outDir: string, apiKeySource: string | null }>}
 */
async function runAssembled(context, spec, assembled) {
  const outDir = sessionDir(context.out, spec.key);
  const session = await runSession({
    cwd: assembled.root,
    outDir,
    argv: childArgv({
      prompt: spec.prompt,
      model: spec.model,
      perRun: context.options.perRun,
      tools: spec.tools,
    }),
    env: context.env,
    timeoutMinutes: context.options.timeoutMinutes,
    home: process.env.HOME ?? homedir(),
  });
  const apiKeySource = readApiKeySource(join(outDir, STREAM));
  writeRunRecord({ context, spec, assembled, session, outDir, apiKeySource });
  return {
    sessionId: session.sessionId,
    resultEvent: session.resultEvent,
    outDir,
    apiKeySource,
  };
}

/**
 * The one session runner every paid path uses: assemble, run the child, read the left tree,
 * and write `run.json`.
 *
 * @param {PaidContext} context
 * @param {SessionSpec} spec
 */
function runOneSession(context, spec) {
  return runAssembled(context, spec, assembleForSpec(context, spec));
}

/**
 * Runs one job through the meter.
 *
 * @template TOutcome
 * @param {PaidContext} context
 * @param {import('./layout.mjs').SessionKey} key
 * @param {() => Promise<TOutcome>} run
 * @returns {Promise<TOutcome | null>} null when the meter refused it.
 */
async function meteredSession(context, key, run) {
  let outcome = null;
  const { refused } = await runMetered({
    out: context.out,
    budget: context.options.budget,
    perRun: context.options.perRun,
    margin: context.options.margin,
    jobs: [key],
    start: async () => {
      outcome = await run();
      return outcome;
    },
  });
  if (refused) console.log(`meter refused ${sessionDirName(refused)}`);
  return outcome;
}

/** @param {number | null} value */
function figure(value) {
  return value === null ? 'none' : String(value);
}

/**
 * One probe (a) session, with the manifest hashes taken before and after it.
 *
 * @param {PaidContext} context
 */
async function attemptProbeA(context) {
  const spec = {
    key: { probe: 'a' },
    prompt: PROBE_A_PROMPT,
    model: PROBE_MODEL,
    tools: NO_TOOLS,
  };
  let before = {};
  let after = {};
  const outcome = await meteredSession(context, spec.key, async () => {
    const assembled = assembleForSpec(context, spec);
    before = manifestHashes(assembled.root);
    const finished = await runAssembled(context, spec, assembled);
    after = manifestHashes(assembled.root);
    return finished;
  });
  if (!outcome) return null;
  return {
    outcome,
    judged: judgeProbeA({ resultEvent: outcome.resultEvent, before, after }),
  };
}

/**
 * Probe (a), rerun once without `houserules` on `PATH` when the first run shows a rewrite.
 *
 * @param {PaidContext} context
 * @returns {Promise<boolean | null>} Whether probe (a) passed, or null when the meter refused it.
 */
async function probeA(context) {
  let run = await attemptProbeA(context);
  if (run && run.judged.rewritten.length > 0) {
    console.log(
      `probe a rewrote ${run.judged.rewritten.length} file(s), rerunning without houserules on PATH`,
    );
    run = await attemptProbeA({
      ...context,
      stamp: `${context.stamp}-rerun`,
      env: {
        ...context.env,
        PATH: pathWithoutHouserules(context.env.PATH ?? ''),
      },
    });
  }
  if (!run) return null;
  const { judged, outcome } = run;
  const isPass = judged.pass && outcome.apiKeySource === API_KEY_SOURCE;
  console.log(
    `probe a: ${isPass ? 'pass' : 'fail'}, quoted ${judged.isQuoted}, files ${judged.fileCount}, rewritten ${judged.rewritten.length}, apiKeySource ${figure(outcome.apiKeySource)}`,
  );
  return isPass;
}

/**
 * Probe (b), priced over its transcripts. Prints its figures and the margin.
 *
 * @param {PaidContext} context
 * @returns {Promise<boolean | null>} Whether probe (b) passed, or null when the meter refused it.
 */
async function probeB(context) {
  const spec = {
    key: { probe: 'b' },
    prompt: PROBE_B_PROMPT,
    model: PROBE_MODEL,
  };
  const outcome = await meteredSession(context, spec.key, () =>
    runOneSession(context, spec),
  );
  if (!outcome) return null;
  const transcripts = join(outcome.outDir, TRANSCRIPTS);
  const pricedUsd = existsSync(transcripts) ? priceTranscripts(transcripts) : 0;
  const judged = judgeProbeB({ resultEvent: outcome.resultEvent, pricedUsd });
  const isPass = judged.pass && outcome.apiKeySource === API_KEY_SOURCE;
  const total = outcome.resultEvent?.total_cost_usd;
  console.log(
    `probe b: ${isPass ? 'pass' : 'fail'}, subtype ${outcome.resultEvent?.subtype ?? 'none'}, total ${typeof total === 'number' ? total : 'none'}, priced ${pricedUsd}, ratio ${figure(judged.ratio)}, reached cap ${judged.hasReachedCap}, budget stop ${judged.isBudgetStop}, match ${judged.isMatch}, apiKeySource ${figure(outcome.apiKeySource)}, session ${figure(outcome.sessionId)}`,
  );
  console.log(`margin ${figure(judged.margin)}`);
  return isPass;
}

/**
 * @param {PaidContext} context
 * @returns {Promise<number>} 2 when the meter refused a probe, since its checks never ran.
 */
async function preflight(context) {
  const isPassA = await probeA(context);
  if (isPassA === null) return EXIT_NOT_STARTED;
  const isPassB = await probeB(context);
  if (isPassB === null) return EXIT_NOT_STARTED;
  return isPassA && isPassB ? EXIT_OK : EXIT_FAILED;
}

/**
 * Every `sample-<k>` directory under `out`, by sample number.
 *
 * @param {string} out
 * @returns {Array<{ number: number, dir: string }>}
 */
function sampleDirs(out) {
  if (!existsSync(out)) return [];
  return readdirSync(out, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SAMPLE_DIR.test(entry.name))
    .map((entry) => ({
      number: Number(SAMPLE_DIR.exec(entry.name)[1]),
      dir: join(out, entry.name),
    }))
    .sort((left, right) => left.number - right.number);
}

/**
 * The jobs a sample run still needs: the missing valid samples, numbered after the highest
 * existing one, then the no-slug session unless the ledger already holds one.
 *
 * @param {ReturnType<typeof parseOptions>} options
 * @param {string} out
 * @returns {import('./layout.mjs').SessionKey[]}
 */
function queueJobs(options, out) {
  const existing = sampleDirs(out);
  const validCount = existing.filter(
    ({ dir }) => judgeValidity(loadSample(dir)).valid,
  ).length;
  const highest = existing.at(-1)?.number ?? 0;
  const missing = Math.max(options.samples - validCount, 0);
  /** @type {import('./layout.mjs').SessionKey[]} */
  const jobs = Array.from({ length: missing }, (_, index) => ({
    sample: highest + index + 1,
  }));
  const hasNoSlugLine = readLedger(out).some((line) => line.noSlug === true);
  if (options.hasNoSlug && !hasNoSlugLine) jobs.push({ noSlug: true });
  return jobs;
}

/**
 * @param {PaidContext} context
 * @returns {Promise<number>}
 */
async function sampleLoop(context) {
  const jobs = queueJobs(context.options, context.out);
  const { refused } = await runMetered({
    out: context.out,
    budget: context.options.budget,
    perRun: context.options.perRun,
    margin: context.options.margin,
    jobs,
    start: (key) =>
      runOneSession(context, {
        key,
        prompt: 'noSlug' in key ? NO_SLUG_PROMPT : SAMPLE_PROMPT,
        model: SAMPLE_MODEL,
      }),
  });
  if (refused) {
    for (const key of jobs.slice(jobs.indexOf(refused))) {
      console.log(`meter refused ${sessionDirName(key)}`);
    }
  }
  return writeVerdict(context.out);
}

/**
 * Runs one arm sample: assemble it with the overlay, run the child, hash the overlay at exit,
 * copy the `collect` paths into `tree/`, and write `run.json`.
 *
 * @param {PaidContext & { fixture: import('./fixture-arm.mjs').ArmFixture }} context
 * @param {import('./layout.mjs').ArmKey} key
 */
async function runArmSession(context, key) {
  const { fixture } = context;
  const assembled = assembleArmSample({
    fixture,
    cliPath: context.cliPath,
    work: context.work,
    stamp: context.stamp,
    sample: key.sample,
  });
  const outDir = armSessionDir(context.out, key);
  const session = await runSession({
    cwd: assembled.root,
    outDir,
    argv: childArgv({
      prompt: fixture.prompt,
      model: fixture.model,
      perRun: context.options.perRun,
      isNetworkAllowed: fixture.isNetworkAllowed,
    }),
    env: context.env,
    timeoutMinutes: context.options.timeoutMinutes,
    home: process.env.HOME ?? homedir(),
  });
  const overlays = exitOverlayHashes(assembled.root, assembled.overlays);
  copyCollect(assembled.root, fixture.collect, outDir);
  /** @type {import('./layout.mjs').ArmRunRecord} */
  const record = {
    arm: key.arm,
    sample: key.sample,
    claudeVersion: context.version,
    commit: context.commit,
    stamp: context.stamp,
    root: assembled.root,
    prompt: fixture.prompt,
    model: fixture.model,
    validityAgent: fixture.validityAgent,
    exitCode: session.exitCode,
    timedOut: session.timedOut,
    sessionId: session.sessionId,
    apiKeySource: readApiKeySource(join(outDir, STREAM)),
    overlays,
  };
  writeFileSync(join(outDir, RUN_JSON), `${JSON.stringify(record, null, 2)}\n`);
  return { sessionId: session.sessionId, resultEvent: session.resultEvent };
}

/**
 * Starts the arm samples `--samples` still needs, numbered after the arm's highest, under the
 * meter of the whole `--out` ledger. Prints each refused sample and every sample's validity.
 *
 * @param {PaidContext & { fixture: import('./fixture-arm.mjs').ArmFixture }} context
 * @returns {Promise<number>} 0 when every job started, 2 when the meter refused one.
 */
async function armLoop(context) {
  const { fixture, options } = context;
  const armOut = join(context.out, fixture.arm);
  const judge = (dir) =>
    judgeArmValidity(loadSample(dir), fixture.validityAgent);
  const existing = sampleDirs(armOut);
  const validCount = existing.filter(({ dir }) => judge(dir).valid).length;
  const highest = existing.at(-1)?.number ?? 0;
  const missing = Math.max(options.samples - validCount, 0);
  /** @type {import('./layout.mjs').ArmKey[]} */
  const jobs =
    options.sample === undefined
      ? Array.from({ length: missing }, (_, index) => ({
          arm: fixture.arm,
          sample: highest + index + 1,
        }))
      : [{ arm: fixture.arm, sample: options.sample }];
  const { refused } = await runMetered({
    out: context.out,
    budget: options.budget,
    perRun: options.perRun,
    margin: options.margin,
    jobs,
    start: (key) => runArmSession(context, key),
  });
  if (refused) {
    for (const key of jobs.slice(jobs.indexOf(refused))) {
      console.log(`meter refused ${key.arm}/sample-${key.sample}`);
    }
  }
  for (const { dir } of sampleDirs(armOut)) {
    console.log(`${fixture.arm}/${judge(dir).line}`);
  }
  return refused ? EXIT_NOT_STARTED : EXIT_OK;
}

/**
 * Judges every session in `out`, writes `verdict.json`, and prints one line per claim.
 *
 * @param {string} out
 * @returns {number} The verdict's exit code.
 */
function writeVerdict(out) {
  const samples = sampleDirs(out).map(({ dir }) => loadSample(dir));
  const noSlugDir = sessionDir(out, { noSlug: true });
  const noSlug = existsSync(noSlugDir) ? loadSample(noSlugDir) : null;
  const result = verdict({ samples, noSlug });
  writeFileSync(
    join(out, VERDICT),
    `${JSON.stringify({ claims: result.claims, lines: result.lines, exitCode: result.exitCode }, null, 2)}\n`,
  );
  for (const id of CLAIM_IDS) console.log(`${id} ${result.claims[id]}`);
  return result.exitCode;
}

/**
 * @param {ReturnType<typeof parseOptions>} options
 * @param {{ work: string, apiKey: string }} started
 * @returns {Promise<number>}
 */
async function paidRun(options, started) {
  const out = resolve(options.out);
  const env = { ...childEnv(process.env), ANTHROPIC_API_KEY: started.apiKey };
  delete env.ANTHROPIC_AUTH_TOKEN;
  return withLock(out, async () => {
    const { commit, cliPath } = resolveCli(options.rev);
    /** @type {PaidContext} */
    const context = {
      options,
      work: started.work,
      out,
      stamp: makeStamp(),
      commit,
      cliPath,
      version: claudeVersion(process.env),
      env,
      fixture: started.fixture,
    };
    if (context.fixture) return armLoop(context);
    return options.isPreflight ? preflight(context) : sampleLoop(context);
  });
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} The process exit code.
 */
async function main(argv) {
  try {
    const options = parseOptions(argv);
    const started = refuseBeforeStart(options);
    if (options.isVerdictOnly) {
      const out = resolve(options.out);
      if (!existsSync(out)) throw new UsageError(`--out ${out} does not exist`);
      return writeVerdict(out);
    }
    if (!options.isPaid) {
      return started.fixture
        ? fixtureDryRun(options, started.work, started.fixture)
        : dryRun(options, started.work);
    }
    return await paidRun(options, started);
  } catch (error) {
    console.error(`eval: ${error.message}`);
    return EXIT_NOT_STARTED;
  }
}

const isRunDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isRunDirectly) process.exitCode = await main(process.argv.slice(2));
