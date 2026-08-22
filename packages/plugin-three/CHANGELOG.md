# @houserules/plugin-three

## 0.2.1

### Patch Changes

- 6a5152b: External dependency versions are now managed through the pnpm workspace catalog.

## 0.2.0

### Minor Changes

- e11c60f: Three.js upstream docs now cover only the chosen framework bindings.

## 0.1.1

### Patch Changes

- 269dd06: Fix wireit check inputs so tsconfig and payload-test edits re-run typecheck

## 0.1.0

### Minor Changes

- 359e22c: Initial release. Three.js authoring patterns, with opt-in Threlte and React Three Fiber guides.

  The rule covers the decisions that cost frames: disposal, instancing, and what belongs outside the render loop. Choose the Threlte or React Three Fiber guide for your renderer, and the optional performance reference for the deeper budget work. The rule links whichever guides you selected, so nothing installs unreachable.
