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
runnable Vitest examples, see `testing-typescript.md`. The patterns there apply directly to
JavaScript test files, with the type annotations dropped.

## Rule — follow without deliberation

- **Pick one suffix per repo, `.test.js` or `.spec.js`, and never mix them.** Two conventions
  mean every glob in the repo has to list both, and one of them eventually gets missed.
- **Exclude tests from the build.** A test under a compiled source root is emitted into the
  published output and imports the test runner, which is a dev dependency. Add the exclude to
  the build config, then check the output directory for a `__test__` after building.
