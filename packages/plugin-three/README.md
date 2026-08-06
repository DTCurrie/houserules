# @agent-kit/plugin-three

[![npm](https://img.shields.io/npm/v/@agent-kit/plugin-three.svg)](https://www.npmjs.com/package/@agent-kit/plugin-three)
[![downloads](https://img.shields.io/npm/dm/@agent-kit/plugin-three.svg)](https://www.npmjs.com/package/@agent-kit/plugin-three)

An agent writing Three.js reaches for a wrapper object around a scene graph node instead of
extending the class directly, and allocates a new `Vector3` inside the render loop instead of
reusing one at module scope. Neither mistake throws. Both show up later as a garbage-collector
stall or a scene graph that fights the library instead of using it, well after the code that
caused it has been forgotten.

This plugin ships the Three.js extension-pattern rule that catches those before they ship, as
a rule the agent loads only when the Three.js layer is in the working set.

## Install

```
pnpm add -D @agent-kit/plugin-three
pnpm exec agent-kit init
```

Requires [`@agent-kit/cli`](https://github.com/DTCurrie/agent-kit/tree/main/packages/cli).
`init` is what writes the module into `.claude/`. This module is off by default, so select it
when `init` asks.

## Modules

- **`three`** installs `.claude/rules/three.md`, a path-scoped rule covering Three.js
  extension patterns: extend Three.js classes directly rather than wrapping them,
  pre-allocate temporaries at module scope, `BatchedMesh` or `InstancedMesh` past a few dozen
  objects, custom `BufferGeometry` via typed-array attributes, custom shaders, and overriding
  `raycast` when the default bounds test is wrong.

  Scoped to `**/three/**`, `**/*.three.ts`, and `**/*.glsl` through its `paths:` frontmatter,
  so it loads only when the Three.js layer is in the working set. Keep that frontmatter. A
  rule file without `paths:` is loaded on every turn.

  Takes an option for framework binding guides, both off by default since neither is true of
  a repo the installer knows nothing about:

  - `threlte`: the Svelte binding residue, `<T>` and `<T is={obj} />`, `useTask`, `useThrelte`.
  - `r3f`: the React binding residue, `useFrame`, `useThree`,
    `<primitive object={obj} />`, `useMemo` for geometry and material, and disposal.
  - `performance`: a pull-only renderer performance reference, read when a frame budget is
    the problem rather than loaded on every matching turn.

  Each guide's `paths:` is a strict subset of the base rule's `**/three/**`, so a guide never
  loads on a file where the base rule is absent. Widening the base rule's `paths:` means
  widening an installed guide's the same way.

## Part of agent-kit

[agent-kit](https://github.com/DTCurrie/agent-kit) is a portable kit of Claude Code
infrastructure that keeps the agent's context lean. This is one of eleven first-party plugins.
The [package list](https://github.com/DTCurrie/agent-kit#packages) has the rest.

## License

MIT. See [LICENSE](./LICENSE).
