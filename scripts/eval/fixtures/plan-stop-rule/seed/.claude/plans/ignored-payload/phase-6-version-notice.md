# Phase 6: version-notice

**Status:** TODO · **Part of:** [PLAN.md](PLAN.md) · **Roadmap:** [ROADMAP.md](ROADMAP.md)

## Objective

A user learns a newer houserules exists without looking. Done when the sync hook prints one line,
`[houserules] <new> available (installed <old>)` plus the upgrade command for the detected package
manager, at most once per day per checkout, and prints nothing when current, offline, or opted
out. The hook's session-start cost with a warm cache is a file read.

## Reference

- Phase 3's sync script, which this extends.
- The project rule on private data: a request to an outside service carries nothing about the user
  or the repo.

## Steps

- [ ] The check asks the registry for the latest version of `@houserules/cli` and of each
      `@houserules/` package in the manifest's `plugins`. The registry is the `npm_config_registry`
      environment variable when set, else `https://registry.npmjs.org`. No `.npmrc` is parsed. The
      request carries the package name and a generic client name, and nothing else. `payload-sync`
      spawns the checker as a detached, unreferenced `node` process, so session start never waits
      on the network. The checker writes `.claude/state/version-check.json` (new), which the state
      directory's existing `.gitignore` covers and the manifest does not track. `payload-sync`
      prints from that file on the next start, with the upgrade command built from the config's
      `packageManager`. A git worktree has its own state directory and so its own daily line. Acceptance: a test with a stubbed registry asserts the cache
      contents, and a test with an unreachable registry asserts no output and exit 0.
- [ ] The cache holds the checked-at time and the versions seen. A check newer than one day is not
      repeated, and a version already announced that day is not announced again. Acceptance: a test
      drives the clock across the boundary and counts requests and printed lines.
- [ ] The config gains `versionCheck`, a boolean that defaults to on. The check is also off when
      `CI` is set or `NO_UPDATE_NOTIFIER` is set, the convention other CLIs honor. Regenerate the
      JSON Schema. Acceptance: tests for the config flag and both environment variables assert no
      request is made.
- [ ] `doctor` gains a readout with the installed and latest versions, read from the same cache and
      never a failure. Acceptance: `doctor` on a fixture with a stale cache prints the readout and
      keeps its exit code.
- [ ] README: document the check, what it sends, and how to turn it off. Record the changeset.
      Acceptance: the four gates exit 0.

## Notes & decisions
