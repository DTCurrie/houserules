# @houserules/test

[![npm](https://img.shields.io/npm/v/@houserules/test.svg)](https://www.npmjs.com/package/@houserules/test)

Shared testing infrastructure for driving the [houserules](https://github.com/DTCurrie/houserules)
CLI against synthetic repos. Built for the CLI's own suites, and published so a plugin author
can write the same kind of test against their own plugin without reimplementing repo staging,
subprocess running, and installed-tree assertions from scratch.

## Install

```
pnpm add -D @houserules/test
```

Requires [`@houserules/cli`](https://github.com/DTCurrie/houserules/tree/main/packages/cli) and
`vitest` as peers.

## Usage

Point `vitest`'s `globalSetup` at `@houserules/test/global-setup` so each run gets its own temp
state, then stage a repo with houserules already installed and assert against the result:

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['@houserules/test/global-setup'],
  },
});
```

```ts
// src/__tests__/typescript.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '@houserules/test/repo';
import { manifestOf } from '@houserules/test/installed-tree';

const PLUGIN = fileURLToPath(new URL('../..', import.meta.url));

describe('typescript', () => {
  it('installs a path-scoped rule', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'ts/typescript',
      plugins: [{ name: PLUGIN, alias: 'ts' }],
    });

    const ruleText = readFileSync(
      join(root, '.claude/rules/typescript.md'),
      'utf8',
    );

    expect(ruleText).toMatch(/^ {2}- ['"]\*\*\/\*\.ts['"]$/m);
    expect(manifestOf(root).modules.includes('ts/typescript')).toBe(true);
  });
});
```

`useInstalledRepo` stages by copying a cached post-`init` snapshot rather than running `init` in
every test, so a regression in `init` fails one suite instead of every suite that depends on it.

## What it provides

- **`@houserules/test/repo`**: `useRepo` and `useInstalledRepo` build synthetic repos and remove
  them after the test. `useInstalledRepo` stages from a cached snapshot with houserules already
  installed. `useRepo` gives a bare repo, for tests whose subject is `init` itself. `treeHash`
  hashes a directory tree for drift assertions.
- **`@houserules/test/run`**: `runCli` runs the houserules CLI as a subprocess without throwing, so a
  test can assert on the exit code. `runScript` runs an installed payload script inside a target
  repo, hook-style with JSON on stdin. `runIn` runs a setup command such as `git add` inside a
  directory and throws on a non-zero exit.
- **`@houserules/test/installed-tree`**: readers over an installed repo, including `readJson`,
  `settingsOf`, `hookCommandsFor`, `allHookCommands`, `manifestOf`, `writeManifest`,
  `houseConfigPath`, `editHouseConfig`, `claudeMdPath`, and `readClaudeMd`.
- **`@houserules/test/doctor-report`**: `runDoctorJson` runs `doctor --json` and returns it as a
  queryable `JsonReport`. `driftFor` reads the drift entry for one file.
- **`@houserules/test/runner-stub`**: `stubRunner` writes a fake package-manager runner that
  records every invocation instead of running one. `recordedCalls` reads back the argv each
  call passed.
- **`@houserules/test/global-setup`**: a Vitest `globalSetup` that creates the per-run temp
  directory `useInstalledRepo` snapshots into, and removes it on teardown. It does not build
  houserules. Installing `@houserules/cli` from npm gives you `dist/` prebuilt, and inside this
  workspace each `test` script declares a wireit dependency on the CLI's build instead.
- **`@houserules/test/hook-input`**: `readToolInput` and `promptInput` build the JSON payloads
  `runScript` expects on stdin for hook-style scripts.

## Part of houserules

[houserules](https://github.com/DTCurrie/houserules) is portable Claude Code
infrastructure that keeps the agent's context lean. The
[package list](https://github.com/DTCurrie/houserules#packages) has the rest.

## License

MIT. See [LICENSE](./LICENSE).
