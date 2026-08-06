---
paths:
  - '**/three/**/*.svelte'
  - '**/three/**/*.svelte.ts'
---

# Three.js — Threlte

Assumes `three.md`. This is the Svelte binding residue only, not a restatement of the base rule.

## Handing an object to the scene graph

Use `<T>` to declare Three.js objects in a Threlte scene, and `<T is={obj} />` to hand a
pre-built object from the pure Three.js layer to the scene graph instead of rebuilding it
declaratively:

```svelte
<T is={obj} />
```

An object the pure layer built stays that object. Threlte places it, it does not recreate it.

## Frame loop and renderer access

Use `useTask` for a per-frame callback, and `useThrelte` to reach the renderer, camera, or
scene outside a `<T>` block:

```svelte
<script lang="ts">
  import { useTask, useThrelte } from "@threlte/core";

  const { renderer, camera } = useThrelte();

  useTask((delta) => {
    // ...
  });
</script>
```

## Svelte 5 runes only

Never `export let` or `$:`. Use `$props()`, `$state()`, and `$derived()`.
