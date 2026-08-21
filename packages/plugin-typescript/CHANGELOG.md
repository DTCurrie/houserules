# @houserules/plugin-typescript

## 0.1.1

### Patch Changes

- 269dd06: Fix wireit check inputs so tsconfig and payload-test edits re-run typecheck

## 0.1.0

### Minor Changes

- 359e22c: Initial release. A path-scoped TypeScript rule covering the type-system decisions that have a right answer.

  Assumes `strict: true`. `interface` for object shapes because they extend, `type` for unions and computed types, and never `any` for untyped external data: use `unknown` and narrow with a type guard. Defers naming, function size, and comment questions to the rules that own them.
