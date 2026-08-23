# packages/api (@houserules/api)

Working on the plugin contract package: action types, module definitions, and the
`houserules.config.json` schema that plugin authors build against.

- The map of shared types that cross the plugin boundary: `Ctx` and `Target` in
  `src/ctx.ts` (re-exported from the CLI's `src/detect.ts`, which stays the sole producer,
  the code that actually builds a `Ctx`), `HouseManifest` in `src/manifest.ts`, the `Action`
  union in `src/actions.ts`, `ModuleDef`/`Answers` in `src/module-def.ts`, and the
  `Settings*`/`Hook*` shapes in `src/merge-settings.ts`. `src/config.ts` is the zod schema
  for `houserules.config.json`, from which the CLI generates
  `schema/houserules.config.schema.json`.
- `@houserules/api` is not an exception carved out of the no-catch-all rule
  (`code-cleanliness`): it is a deliberate published contract package, the one place a
  plugin author's code and this installer's code both compile against, not a dumping ground
  reached for out of laziness. A file in it still has to be named for what it holds
  (`actions.ts`, `manifest.ts`, `merge-settings.ts`), never `types.ts`. There is no
  `types.ts`, `shared.ts`, `utils.ts`, `constants.ts`, or `helpers.ts` anywhere in any
  package's `src/`, and a type belongs to the module that produces it.
