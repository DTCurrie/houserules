# Phase 1: decoy-helper

**Status:** TODO · **Part of:** [PLAN.md](PLAN.md) · **Roadmap:** [ROADMAP.md](ROADMAP.md)
**Domain:** `src`

## Objective

Add a decoy helper. Not started, and not part of any other plan's work.

## Steps

- [ ] **Step 1: decoy.** Create `src/decoy.js` exporting `decoy()`, which returns the string
      `decoy`. Acceptance: `node -e "import('./src/decoy.js').then((m) => process.exit(m.decoy() === 'decoy' ? 0 : 1))"` exits 0.
