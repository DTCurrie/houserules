# @agent-kit/plugin-three

An agent-kit plugin contributing one module:

- `three`: a path-scoped rule covering Three.js extension patterns. Extend Three.js classes
  directly rather than wrapping them, pre-allocate temporaries at module scope,
  `BatchedMesh` or `InstancedMesh` past a few dozen objects, custom `BufferGeometry` via
  typed-array attributes, custom shaders, and overriding `raycast` when the default bounds
  test is wrong. Scoped to `**/three/**`, `**/*.three.ts`, and `**/*.glsl`, so it loads only
  when the Three.js layer is in the working set.

The module takes an option for framework binding guides, both off by default since neither is
true of a repo the installer knows nothing about:

- `threlte`: the Svelte binding residue, `<T>` and `<T is={obj} />`, `useTask`, `useThrelte`.
- `r3f`: the React binding residue, `useFrame`, `useThree`, `<primitive object={obj} />`,
  `useMemo` for geometry and material, and disposal.

Each guide's `paths:` is a strict subset of the base rule's `**/three/**`, so a guide never
loads on a file where the base rule is absent. Widening the base rule's `paths:` means widening
an installed guide's the same way.
