---
paths:
  - '**/*.test.js'
  - '**/*.test.mjs'
  - '**/*.spec.js'
  - '**/*.spec.mjs'
---

# Testing — JavaScript

Language-specific guidance for JavaScript test files. See `testing.md` for the
runner-agnostic rules on placement, structure, and naming that this guide assumes. For
runnable Vitest examples, see `testing-typescript.md` if that rule is installed. The patterns
there apply directly to JavaScript test files, with the type annotations dropped.

## Rule — follow without deliberation

- **Pick one suffix per repo, `.test.js` or `.spec.js`, and never mix them.** Two conventions
  mean every glob in the repo has to list both, and one of them eventually gets missed.

## Where other rules apply

- Excluding tests from the build: see `testing-typescript.md` if that rule is installed.
