import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mergeProfiles, profileCase, selfTimeByFrame } from '../profile.mjs';

const HOT_FIXTURE = fileURLToPath(
  new URL('../fixtures/profile/hot.mjs', import.meta.url),
);
const GIT_SHA_LENGTH = 40;
const FAKE_SHA = 'f'.repeat(GIT_SHA_LENGTH);
const scratch = mkdtempSync(join(tmpdir(), 'bench-profile-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function frame(id, functionName, url, lineNumber) {
  return { id, callFrame: { functionName, url, lineNumber } };
}

// Sample i is charged timeDeltas[i + 1] microseconds, and the last sample is charged nothing.
const HAND_PROFILE = {
  nodes: [
    frame(1, '(root)', '', -1),
    frame(2, 'alpha', 'file:///a.mjs', 9),
    frame(3, '', 'file:///a.mjs', 19),
  ],
  samples: [2, 3, 2, 2],
  timeDeltas: [5000, 1000, 2000, 3000, 4000],
};

describe('selfTimeByFrame', () => {
  it('charges each sample the following delta and merges nodes by frame', () => {
    const { totalMs, frames } = selfTimeByFrame(HAND_PROFILE);
    assert.equal(totalMs, 10);
    const byName = Object.fromEntries(
      [...frames.values()].map((entry) => [entry.functionName, entry]),
    );
    assert.equal(byName.alpha.selfMs, 8);
    assert.equal(byName.alpha.line, 10);
    assert.equal(byName['(anonymous)'].selfMs, 2);
    assert.equal(byName['(anonymous)'].line, 20);
  });
});

describe('mergeProfiles', () => {
  it('sums across profiles, sorts by self time, and computes shares', () => {
    const merged = mergeProfiles([HAND_PROFILE, HAND_PROFILE], 1);
    assert.equal(merged.totalSelfMs, 20);
    assert.deepEqual(merged.totalsMs, [10, 10]);
    assert.deepEqual(merged.topFrames, [
      {
        functionName: 'alpha',
        url: 'file:///a.mjs',
        line: 10,
        selfMs: 16,
        selfPercent: 80,
      },
    ]);
  });
});

describe('profileCase', () => {
  it('finds the known hot function in a real node profile', () => {
    const profilesRoot = join(scratch, 'profiles');
    const result = profileCase(
      {
        name: 'hot',
        command: process.execPath,
        args: [HOT_FIXTURE],
        cwd: scratch,
      },
      {
        id: 'fixture/hot',
        build: { root: scratch, sha: FAKE_SHA },
        runs: 2,
        top: 5,
        interval: 100,
        profilesRoot,
      },
    );
    assert.equal(result.case, 'fixture/hot');
    assert.equal(result.profiles.length, 2);
    assert.ok(result.profileDir.startsWith(profilesRoot));
    assert.ok(existsSync(join(result.profileDir, result.profiles[0].file)));
    assert.equal(result.topFrames[0].functionName, 'knownHotSpin');
    assert.ok(result.topFrames[0].selfPercent > 50);
    assert.equal(result.topFrames[0].line, 2);
  });
});
