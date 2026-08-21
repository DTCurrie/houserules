# @houserules/api

## 0.1.1

### Patch Changes

- 269dd06: Route the missing-hook-script fallback to stderr so it is not injected as context
- Updated dependencies [269dd06]
  - @houserules/payload@0.1.1

## 0.1.0

### Minor Changes

- 359e22c: Initial release. The contract a houserules plugin codes against, split out of the installer.

  Holds the plugin API, the action union, the module definition, the settings shapes, and the
  `houserules.config.json` schema. A plugin depends on this rather than on `@houserules/cli`, so the installer
  stays out of its dependency graph. `definePlugin` types a plugin's default export, and `PluginApi`
  hands it action builders already rooted at its own `payload-dist/`, so a plugin resolves no paths of
  its own.

  Nothing here writes. `apply`, the filesystem target, and the plan engine are not reachable from this
  package. A plugin declares actions and houserules decides what they mean against the real tree, which is
  the invariant the dry-run story rests on.

  Two entry points. `@houserules/api` is the plugin contract and is the one to import.
  `@houserules/api/internal` exists so the installer can reach shared code across the package boundary,
  and is not a stable surface.

### Patch Changes

- Updated dependencies [359e22c]
  - @houserules/payload@0.1.0
