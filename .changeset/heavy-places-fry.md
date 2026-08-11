---
'@agent-kit/plugin-testing': minor
---

Initial release. A runner-agnostic testing rule, split into opt-in guides.

The rule decides whether a test is worth writing, where it lives, what it covers, and how it is named. Its bar is falsifiability: a test earns its place by failing when the behavior breaks, and the rule tells you to check that by introducing the bug and watching it go red.

Covers colocation in `__test__/` beside the subject, splitting by subject rather than by unit-versus-end-to-end, asserting values rather than existence, and the failure modes that pass forever.

Four opt-in guides carry what does not generalize. `testing-typescript` and `testing-javascript` hold the language half, including when a type test earns its place and the Vitest `typecheck` setting without which one asserts nothing. `testing-svelte` covers browser mode over jsdom, since jsdom under-simulates Svelte 5 effect timing, and the three-project client, ssr, and server split. `testing-3d` covers asserting scene-graph structure rather than pixels, and the mount-unmount-assert cycle that catches a disposal leak no rendering test notices.
