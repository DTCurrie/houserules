---
'@agent-kit/plugin-testing': minor
---

Initial release. A runner-agnostic testing rule, split into opt-in per-language guides.

The rule decides whether a test is worth writing, where it lives, what it covers, and how it is named. Its bar is falsifiability: a test earns its place by failing when the behavior breaks, and the rule tells you to check that by introducing the bug and watching it go red.

Covers colocation in `__test__/` beside the subject, splitting by subject rather than by unit-versus-end-to-end, asserting values rather than existence, and the failure modes that pass forever. Opt into `testing-typescript` or `testing-javascript` for the language-specific half.
