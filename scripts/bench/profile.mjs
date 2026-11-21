/**
 * CPU profiling for one bench case. Pure helpers merge V8 `.cpuprofile` files into self time per
 * frame, and `profileCase` runs a case under node's profiler and returns the merged top frames.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureCase } from './timing.mjs';

const MICROSECONDS_PER_MILLISECOND = 1000;
const PERCENT = 100;
const ROUND_FACTOR = 1000;
const FRAME_KEY_SEPARATOR = '\u0000';
const UNTIMED_WARMUP_SETTINGS = { warmup: 0, runs: 1 };
const ANONYMOUS = '(anonymous)';
const PROFILE_SUFFIX = '.cpuprofile';
const PROFILE_DIR_PREFIX = 'profile-';

/** Default profile root: `<os.tmpdir()>/houserules-bench/profiles`. */
function defaultProfilesRoot() {
  return join(tmpdir(), 'houserules-bench', 'profiles');
}

function round(value) {
  return Math.round(value * ROUND_FACTOR) / ROUND_FACTOR;
}

/**
 * Self time per frame in one V8 cpuprofile. Sample `i` is charged the delta that follows it, the
 * time until the next sample, so the startup gap before the first sample is not charged to it.
 * The last sample has no following delta and is charged nothing.
 *
 * @param {{ nodes: object[], samples: number[], timeDeltas: number[] }} profile
 * @returns {{ totalMs: number, frames: Map<string, { functionName: string, url: string, line: number, selfMs: number }> }}
 */
export function selfTimeByFrame(profile) {
  const nodesById = new Map(profile.nodes.map((node) => [node.id, node]));
  const frames = new Map();
  let totalMs = 0;
  const chargeable = Math.min(
    profile.samples.length,
    profile.timeDeltas.length - 1,
  );
  for (let index = 0; index < chargeable; index++) {
    const node = nodesById.get(profile.samples[index]);
    const deltaMicroseconds = profile.timeDeltas[index + 1];
    const { functionName, url, lineNumber } = node.callFrame;
    const name = functionName || ANONYMOUS;
    const line = lineNumber + 1;
    const key = [name, url, line].join(FRAME_KEY_SEPARATOR);
    const selfMs = deltaMicroseconds / MICROSECONDS_PER_MILLISECOND;
    const entry = frames.get(key) ?? {
      functionName: name,
      url,
      line,
      selfMs: 0,
    };
    entry.selfMs += selfMs;
    frames.set(key, entry);
    totalMs += selfMs;
  }
  return { totalMs, frames };
}

/**
 * Merge profiles into top frames, keyed by function name, url, and line, by self time descending.
 *
 * @param {object[]} profiles parsed `.cpuprofile` objects
 * @param {number} top how many frames to keep
 * @returns {{ totalSelfMs: number, totalsMs: number[], topFrames: Array<{ functionName: string, url: string, line: number, selfMs: number, selfPercent: number }> }}
 */
export function mergeProfiles(profiles, top) {
  const merged = new Map();
  const totalsMs = [];
  let totalSelfMs = 0;
  for (const profile of profiles) {
    const { totalMs, frames } = selfTimeByFrame(profile);
    totalsMs.push(totalMs);
    totalSelfMs += totalMs;
    for (const [key, frame] of frames) {
      const entry = merged.get(key) ?? { ...frame, selfMs: 0 };
      entry.selfMs += frame.selfMs;
      merged.set(key, entry);
    }
  }
  const topFrames = [...merged.values()]
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, top)
    .map((frame) => ({
      functionName: frame.functionName,
      url: frame.url,
      line: frame.line,
      selfMs: round(frame.selfMs),
      selfPercent:
        totalSelfMs > 0 ? round((frame.selfMs / totalSelfMs) * PERCENT) : 0,
    }));
  return { totalSelfMs: round(totalSelfMs), totalsMs, topFrames };
}

/** The profiler flags appended to `NODE_OPTIONS`, so child node processes profile too. */
function profilerFlags(dir, interval) {
  return `--cpu-prof --cpu-prof-dir=${dir} --cpu-prof-interval=${interval}`;
}

function readProfiles(profileDir) {
  const files = readdirSync(profileDir)
    .filter((file) => file.endsWith(PROFILE_SUFFIX))
    .sort();
  const parsed = files.map((file) =>
    JSON.parse(readFileSync(join(profileDir, file), 'utf8')),
  );
  return { files, parsed };
}

/**
 * Run one case under the profiler and return the merged result. One untimed warmup runs without
 * the profiler, then `runs` runs write `.cpuprofile` files into a fresh directory under
 * `profilesRoot`. Throws `CaseError` when a run fails.
 *
 * @param {object} benchCase see scripts/bench/README.md, "A case"
 * @param {{ id: string, build: { root: string, sha: string }, runs: number, top: number, interval: number, profilesRoot?: string }} options
 */
export function profileCase(benchCase, options) {
  const { id, build, runs, top, interval } = options;
  const profilesRoot = options.profilesRoot ?? defaultProfilesRoot();
  mkdirSync(profilesRoot, { recursive: true });
  const profileDir = mkdtempSync(join(profilesRoot, PROFILE_DIR_PREFIX));
  const existing = benchCase.env?.NODE_OPTIONS ?? process.env.NODE_OPTIONS;
  const nodeOptions = [existing, profilerFlags(profileDir, interval)]
    .filter(Boolean)
    .join(' ');
  const profiledCase = {
    ...benchCase,
    env: { ...benchCase.env, NODE_OPTIONS: nodeOptions },
  };
  measureCase(benchCase, UNTIMED_WARMUP_SETTINGS);
  measureCase(profiledCase, { warmup: 0, runs });
  const { files, parsed } = readProfiles(profileDir);
  const merged = mergeProfiles(parsed, top);
  return {
    case: id,
    build,
    runs,
    interval,
    profileDir,
    profiles: files.map((file, index) => ({
      file,
      totalMs: round(merged.totalsMs[index]),
    })),
    totalSelfMs: merged.totalSelfMs,
    topFrames: merged.topFrames,
  };
}
