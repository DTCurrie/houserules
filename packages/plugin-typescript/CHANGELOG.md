# @houserules/plugin-typescript

## 0.1.5

### Patch Changes

- 7ac34e1: Add @houserules/plugin-wireit, and move wireit specifics out of core scripts into plugin-written extension fragments.

## 0.1.4

### Patch Changes

- 60517b4: Rules declare the other modules they mention.

## 0.1.3

### Patch Changes

- a198513: Rules, skills, and agent prompts are reworded for the current Claude models.

## 0.1.2

### Patch Changes

- 6a5152b: External dependency versions are now managed through the pnpm workspace catalog.

## 0.1.1

### Patch Changes

- 269dd06: Fix wireit check inputs so tsconfig and payload-test edits re-run typecheck

## 0.1.0

### Minor Changes

- 359e22c: Initial release. A path-scoped TypeScript rule covering the type-system decisions that have a right answer.

  Assumes `strict: true`. `interface` for object shapes because they extend, `type` for unions and computed types, and never `any` for untyped external data: use `unknown` and narrow with a type guard. Defers naming, function size, and comment questions to the rules that own them.
