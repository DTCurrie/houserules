---
paths:
  - '**/*.test.ts'
  - '**/*.test.tsx'
  - '**/*.test.mts'
  - '**/*.test.js'
  - '**/*.test.mjs'
  - '**/*.spec.ts'
  - '**/*.spec.tsx'
  - '**/*.spec.mts'
  - '**/*.spec.js'
  - '**/*.spec.mjs'
---

# Testing

This rule decides where a test lives, what it covers, and how it is named. The examples are
Vitest and TypeScript. The principles apply to any test runner with a `describe`/`it` shape.

The rule assumes a test you are writing. When you are changing behavior instead, the test
that covers it is part of the change, not a follow-up.

## Rule — follow without deliberation

### Placement

- **Tests colocate in a `__test__` directory beside the code they cover.** A test for
  `src/core/drift.ts` is `src/core/__test__/drift.test.ts`. Close enough to find without a
  search, in a directory of its own so it does not clutter the module listing.
- **Split by SUBJECT, not by unit versus end-to-end, and setup does not count toward the
  subject.** A test that builds a repo, runs one command, then checks the result is about that
  command. Counting the setup makes everything look cross-cutting and nothing colocates. One
  file per subject, a `describe` per concern, and never a parallel `.e2e.test.ts` tier that
  splits one subject across two places.
- **Assume every test has an owner.** "This one is cross-cutting" is almost always a misreading.
  An entry point is a unit, and so is a test that drives several components as long as one of
  them is the subject. Before filing something as ownerless, name the source file it is about
  and confirm that file does not exist. A test about a whole built tree is owned by that tree,
  so it goes in `<that-tree>/__test__/`.
- **Shared fixtures and setup are not tests, so they do not go in a `__test__/`.** Put them in
  a plainly named `test/` directory. The distinction is worth holding: `__test__/` means tests
  live here, `test/` means testing infrastructure lives here. A `__test__/` containing no tests
  misleads every reader who greps it.
- **Pick one suffix per repo, `.test.ts` or `.spec.ts`, and never mix them.** Two conventions
  mean every glob in the repo has to list both, and one of them eventually gets missed.
- **Exclude tests from the build.** A test under a compiled source root is emitted into the
  published output and imports the test runner, which is a dev dependency. Add the exclude to
  the build config, then check the output directory for a `__test__` after building.

### What to test, and at which level

- **Prefer a unit test over an end-to-end test for the same assertion.** If a decision is
  pure, test the function that makes it. Driving the whole program to observe one branch is
  slower, and the failure names the program rather than the decision.
- **End-to-end tests prove wiring, once.** Cover that the pieces are connected and that the
  real boundaries work, such as exit codes, file writes, and process behavior. Branch coverage
  belongs to units.
- **Extract a pure function when a test wants one.** A decision buried in an I/O function can
  be lifted out with the I/O left at the call site. Let the test drive the extraction rather
  than restructuring code no test asked about.
- **Real implementations by default.** Mock only I/O boundaries: network, file system, time,
  child processes, and randomness. Mocking your own module means the test no longer knows
  whether the two halves still agree.
- **Stage from data, not by running another component.** Building a test's starting state by
  invoking a second subject couples the two, so a regression in the setup path fails every
  suite that used it and the failure names the wrong thing. Prefer a fixture, a factory, or a
  snapshot of the state. Where producing that state is genuinely expensive, produce it once and
  copy it per test. The same goes for verification: do not ask a second component whether the
  first one worked, assert the specific thing you care about.
- **Cover the failure path.** A function with an error branch and no test for it has an
  untested error branch. This is the most common real gap.
- **One behavior per test.** If the name needs "and", it is two tests. Expensive setup is not
  a reason to fuse assertions. Hoist the setup into `beforeEach` instead.
- **Use a case table for one rule over many inputs.** `it.each` keeps the rule in one place and
  names each case in the output.

### Structure

- **Arrange, Act, Assert, in that order, separated by a blank line.** Set up the inputs, perform
  the one action under test, then assert on the result. The shape should be visible at a glance
  without reading the code.
- **Never label the phases with comments.** No `// Arrange`, no `// Act`. The blank lines
  carry the structure.
- **One Act per test.** Two actions means two behaviors, which means two tests. A test that
  arranges, acts, asserts, then acts again is a sequence, and it fails without telling you which
  step broke.
- **Push a complicated Arrange into a named helper**, kept in the test file next to the tests
  that use it. `forgeManifestHash(root, path)` says what five lines of hashing and JSON
  rewriting are for.
- **Assert is where the test earns its keep.** A test whose Arrange dwarfs its Assert is usually
  testing setup, or is missing an extraction from the code under test.

### Naming

- **The description states the observable behavior.** After the subject in `describe`, the
  `it` reads as a sentence: `describe('deepMerge')` plus
  `it('recurses into nested objects rather than clobbering them')`.
- **No identifier prefixes.** No `JM1:`, no case numbers, no ticket IDs. They convey nothing,
  and renumbering makes every reference stale. A unique behavioral description is the handle.
- **Name what the caller observes, not how the code does it.** `it('rejects an expired token')`
  survives a refactor. `it('calls validateExpiry')` does not.
- **Put failure-only context in the `expect` message, not a comment.** The second argument to
  `expect` prints when the assertion fails, which is the moment the context is needed.

### Never

- **No comments in a test file, as the working default.** A test is read far more often than it
  is written, and it has three places to put meaning that a comment does not: the `describe`
  name, the `it` name, and a named helper. Use those. If you are about to write a comment, one
  of the three is wrong.
  - An assertion that needs explaining means the `it` name is wrong. Fix the name.
  - A setup step that needs explaining means it should be a named helper.
  - Context that only matters when the test fails goes in the second argument to `expect`,
    where it actually prints.
  - What survives is the rare domain fact a reader could not infer and no name can carry, such
    as why a malformed input is deliberately tolerated. Keep those short and about the SYSTEM,
    never about the test.
- **No file header comment on a test file.** This is stricter than `code-comments.md`'s
  exception for files that export nothing. A suite's contract is its `describe` names. A header
  restates them, then goes stale.
- **No banner or section dividers inside a test file.** Needing signposts to navigate a suite
  means it should be several suites, split by the unit under test.
- **No assertion-free test.** A test that runs code and asserts nothing passes forever and
  proves nothing. Vitest's `expect.requireAssertions` catches this and is worth turning on.
- **No snapshot standing in for an assertion.** A snapshot of a large structure fails on every
  unrelated change and gets updated without being read. Assert the fields the behavior is
  about.
- **No test that reaches into private state to verify a result.** Assert what a caller can see.
  A test coupled to internals blocks the refactor it was supposed to protect.
- **No conditional in a test body.** An `if` around an assertion means the test has two cases.
  Write two tests, or a case table.
- **No test that polices a repo convention instead of production behavior.** A suite asserting
  where files live, how they are named, or how they are formatted is a lint rule wearing a test
  costume. It fails on a rename that broke nothing and passes while the product is broken. Put
  the convention in a rule, or in the linter if it must be mechanical. A test earns its place by
  telling you something about the code that ships.

### Where other rules apply

- Whether a comment should exist at all: see `code-comments.md`.
- How the sentence inside a description or comment reads: see `prose-voice.md`.
- Naming, function size, and dead code in test helpers: see `code-cleanliness.md`. Helpers are
  code and the same rules apply.

## Examples

**Bad — prefixed name, comments carrying the meaning, four behaviors in one test:**

```ts
test('DR1: doctor states', () => {
  const root = useInstalledRepo('monorepo');

  // healthy after init
  expect(runCli(['doctor', root]).status).toBe(0);

  // A local edit is reported as `yours` and still exits 0.
  appendFileSync(join(root, '.claude/scripts/guard.mjs'), '// tweak\n');
  expect(runCli(['doctor', root]).status).toBe(0);

  // missing file → error
  rmSync(join(root, '.claude/scripts/guard.mjs'));
  expect(runCli(['doctor', root]).status).toBe(1);
});
```

**Good — one behavior each, the name carries what the comment used to:**

```ts
describe('doctor', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('monorepo');
  });

  it('exits 0 on a freshly initialized repo', () => {
    expect(runCli(['doctor', root]).status).toBe(0);
  });

  it('exits 0 when a kit file was edited locally, since nothing can acknowledge the edit', () => {
    appendFileSync(join(root, '.claude/scripts/guard.mjs'), '// tweak\n');
    expect(runCli(['doctor', root]).status).toBe(0);
  });

  it('exits 1 when a kit file is missing', () => {
    rmSync(join(root, '.claude/scripts/guard.mjs'));
    expect(runCli(['doctor', root]).status).toBe(1);
  });
});
```

The one surviving explanation is in the third name, because "exits 0 on a local edit" is
genuinely surprising. The rule it encodes is stated, not narrated.

**Bad — driving the whole program to check one pure decision:**

```ts
it('errors on an unknown module', () => {
  const root = useRepo('monorepo');
  const result = runCli(['init', '--modules=nope', root]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Unknown module/);
});
```

**Good — the decision as a unit, plus one end-to-end test that it is wired in:**

```ts
// src/__test__/plan.test.ts
describe('resolveModuleIds, given a context whose only default is core', () => {
  it('names the offending module when the id does not exist', () => {
    expect(() => resolveModuleIds(ctx, 'nope')).toThrow(
      /Unknown module "nope"/,
    );
  });

  it.each([
    { flag: '', expected: ['core'] },
    { flag: 'terse-style', expected: ['core', 'terse-style'] },
    { flag: 'terse-style,-terse-style', expected: ['core'] },
  ])('resolves "$flag" to $expected', ({ flag, expected }) => {
    expect(resolveModuleIds(ctx, flag)).toEqual(expected);
  });
});
```

Note what the case table pins: a bare id ADDS to the defaults rather than replacing them, and
a leading `-` removes. Those cases were written by reading the implementation, not by guessing
from the flag's name. Guessing is how a test ends up asserting a syntax the code never had.

**Bad — mocking a collaborator the test should be exercising for real:**

```ts
vi.mock('../parse-config', () => ({ parseConfig: () => ({ strict: true }) }));

it('runs in strict mode', () => {
  expect(loadSettings('./config.json').strict).toBe(true);
});
```

Nothing here would fail if `parseConfig` stopped returning `strict`.

**Good — mock the file system, run the real parser:**

```ts
it('runs in strict mode when the config file sets it', () => {
  vi.spyOn(fs, 'readFileSync').mockReturnValue('{"strict": true}');

  expect(loadSettings('./config.json').strict).toBe(true);
});
```

**Bad — a conditional hiding a second case:**

```ts
it('formats the total', () => {
  const result = format(items);
  if (items.length === 0) {
    expect(result).toBe('empty');
  } else {
    expect(result).toMatch(/^\$/);
  }
});
```

**Good — the two cases named:**

```ts
it('returns "empty" for no items', () => {
  expect(format([])).toBe('empty');
});

it('prefixes a currency total with $', () => {
  expect(format([{ price: 3 }])).toMatch(/^\$/);
});
```
