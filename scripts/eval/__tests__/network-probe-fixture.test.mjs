import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { childArgv } from '../child.mjs';
import { loadArmFixture } from '../fixture-arm.mjs';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'network-probe',
);

describe('network-probe fixture', () => {
  const arm = loadArmFixture(FIXTURE, 'probe');

  it('loads with the network closed, no validity agent, and haiku', () => {
    assert.equal(arm.isNetworkAllowed, false);
    assert.equal(arm.validityAgent, null);
    assert.equal(arm.model, 'haiku');
    assert.equal(arm.permissionMode, 'auto');
    assert.equal(arm.modules, 'core');
  });

  it('asks for the three network commands through Bash', () => {
    for (const command of [
      'curl -sS -m 10 https://example.com',
      'git ls-remote https://github.com/git/git HEAD',
      `node -e "fetch('https://example.com').then(r=>console.log(r.status))"`,
    ]) {
      assert.ok(arm.prompt.includes(command), command);
    }
    assert.match(arm.prompt, /verbatim/);
  });

  it('puts the sandbox settings and the web tool denial in the arm argv', () => {
    const argv = childArgv({
      prompt: arm.prompt,
      model: arm.model,
      perRun: 1,
      isNetworkAllowed: arm.isNetworkAllowed,
      permissionMode: arm.permissionMode,
      settings: arm.settings,
    });
    assert.equal(
      argv[argv.indexOf('--disallowedTools') + 1],
      'WebFetch,WebSearch',
    );
    const sandbox = JSON.parse(argv[argv.indexOf('--settings') + 1]).sandbox;
    assert.equal(sandbox.enabled, true);
    assert.equal(sandbox.failIfUnavailable, true);
    assert.deepEqual(sandbox.network, { allowedDomains: [] });
  });
});
