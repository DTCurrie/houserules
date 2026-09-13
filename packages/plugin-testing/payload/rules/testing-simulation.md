---
paths:
  - '**/*.test.ts'
  - '**/*.test.tsx'
  - '**/*.test.mts'
  - '**/*.spec.ts'
  - '**/*.spec.tsx'
  - '**/*.spec.mts'
---

# Testing — Simulation and numeric

Domain guidance for tests that cover a simulation, a tick loop, seeded randomness, or floating
arithmetic. See `testing.md` for the runner-agnostic rules this guide assumes.

## Rule — follow without deliberation

- **A deterministic sim pins exact state.** If the code under test takes `dt` (delta time) as a parameter
  and reads no clock and no `Math.random`, assert with `toBe` or `toEqual`. A tolerance on a
  value like that hides a tick the test never accounted for.
- **Advance, then assert.** Stage the world, advance a named number of fixed steps through the
  real `tick` function, then assert. Name both the step count and `dt` in the test, and choose
  the step count from the mechanic being exercised, not from whatever number happened to make
  the test pass.
- **Randomness is a parameter.** The code under test takes a generator or a seed, never reads
  the global `Math.random` directly. A test passes a fixed sequence or a seed and pins the
  exact output. An unseeded default path is tested once, by range, not by exact value. Never
  patch `Math.random` globally, and restore any generator you did substitute in a `finally`
  block so a failing assertion cannot leave it swapped for the next test.
- **A multi-seed test prints the seed in the failure message.** A test that runs the same
  assertion over several seeds puts the seed in the `expect` message. A red run then tells you
  which seed to replay, instead of forcing a bisection over the whole set.
- **`toBeCloseTo` is a decision, not a default.** It passes when the absolute difference is
  below `10^-n / 2`, which is `0.005` at the default `n = 2`. Use it only for the result of
  floating-point arithmetic. Write `n` explicitly, derive it from the calculation being
  tested, and never compute the expected value with the same formula the code uses. An
  integer, a count, or a value passed through unchanged is exact and takes `toBe`.
- **Invariants are tests.** A relation the correct system must obey, such as conservation,
  monotonicity, or symmetry, is asserted as a case table over seeds, with the assumption
  stated in the `describe` or `it` name and the failure message naming which side broke. When
  the input is a value domain rather than a set of seeds, write the relation once as a
  property test instead of a table.
- **Characterization is allowed, labelled, and bounded.** Output with no independent spec,
  such as a measured constant, a generated table, or an approved simulation trace, may be
  pinned against a committed expected value. The test name states that it characterizes, the
  source of the expected value is named in the test name or the `expect` message, and the
  committed file is read on every change so a diff is visible in review.
- **A threshold over a run is legitimate only when it is named as the behavior.** `it` states
  the threshold itself as the behavior under test (at least one critical hit across a run, no
  survivors below zero at the end tick), or the assertion is a non-vacuity guard with a message
  ahead of an `every()` or `some()` call. Every other sum, count, or aggregate over a
  deterministic run is pinned to its exact value.
- **Fake the clock only where the code has one.** Real `setTimeout` and `Date` code runs under
  a fake-timers seam. A `dt`-driven simulation has no clock in it to fake, so there is nothing
  to install a fake timer over.

## Examples

**Bad — an unchosen tolerance on a deterministic run:**

```ts
it('accrues resources over ten ticks', () => {
  const world = createWorld({ dt: 0.1 });

  for (let i = 0; i < 10; i += 1) {
    tick(world);
  }

  expect(world.resources).toBeCloseTo(42.0);
});
```

**Good — exact state, the step count and `dt` named:**

```ts
it('accrues 42 resources over 10 ticks at dt=0.1', () => {
  const dt = 0.1;
  const steps = 10;
  const world = createWorld({ dt });

  for (let i = 0; i < steps; i += 1) {
    tick(world);
  }

  expect(world.resources).toBe(42);
});
```

`createWorld` here reads no clock and no `Math.random`, so the run is exactly reproducible.
The default `toBeCloseTo()` digit count would have hidden an off-by-one tick error the exact
assertion catches.

**Bad — the tolerance is present but its digit count and derivation are not:**

```ts
it('computes projectile impact speed', () => {
  const speed = impactSpeed({ mass: 12, gravity: 9.8, height: 20 });

  expect(speed).toBeCloseTo(19.8);
});
```

**Good — the digit count is written and derived from the calculation:**

```ts
it('computes projectile impact speed to two significant digits', () => {
  // impactSpeed uses sqrt(2 * gravity * height), independently re-derived here
  const expectedSpeed = Math.sqrt(2 * 9.8 * 20);
  const speed = impactSpeed({ mass: 12, gravity: 9.8, height: 20 });

  expect(speed).toBeCloseTo(expectedSpeed, 2);
});
```

The digit count, `2`, is the precision the physical formula is trusted to, and the expected
value comes from the formula itself rather than a call into the code under test.

**Bad — randomness read from the global, and the test patches it:**

```ts
it('rolls a critical on a high value', () => {
  vi.spyOn(Math, 'random').mockReturnValue(0.99);

  const result = rollAttack();

  expect(result.critical).toBe(true);
});
```

**Good — the generator is an injected parameter, restored after:**

```ts
it('rolls a critical for a fixed sequence', () => {
  const restore = setGenerator(fixedSequence([0.99]));

  try {
    const result = rollAttack();
    expect(result.critical).toBe(true);
  } finally {
    restore();
  }
});
```

`rollAttack` takes its generator through the same seam the production caller uses, so the
test pins an exact, replayable sequence instead of a global patch that leaks into whatever
test runs next if an assertion above it throws.

**Bad — a conservation check with no seed in reach when it fails:**

```ts
it('conserves total health across combat resolution', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const before = totalHealth(setupEncounter(seed));
    const after = totalHealth(resolveCombat(setupEncounter(seed)));

    expect(after).toBeLessThanOrEqual(before);
  }
});
```

**Good — the seed and the two sides of the invariant are in the failure message:**

```ts
it('never grants more damage than the attacker rolled, across seeds', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const encounter = setupEncounter(seed);
    const damageDealt = totalDamageDealt(encounter);
    const damageReceived = totalDamageReceived(resolveCombat(encounter));

    expect(
      damageReceived,
      `seed ${seed}: dealt ${damageDealt}, received ${damageReceived}`,
    ).toBeLessThanOrEqual(damageDealt);
  }
});
```

A red run here names the seed to replay and prints both sides of the relation that broke,
instead of leaving the reader to add logging and re-run the whole table.
