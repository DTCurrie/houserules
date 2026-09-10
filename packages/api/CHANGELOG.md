# @houserules/api

## 0.3.3

### Patch Changes

- 4a119d0: Rule-conformance fixes: tighter test helper types, corrected comments and shipped prose.
- Updated dependencies [4a119d0]
  - @houserules/payload@0.2.3

## 0.3.2

### Patch Changes

- Updated dependencies [c3268ac]
  - @houserules/payload@0.2.2

## 0.3.1

### Patch Changes

- 6a5152b: External dependency versions are now managed through the pnpm workspace catalog.
- Updated dependencies [6a5152b]
  - @houserules/payload@0.2.1

## 0.3.0

### Minor Changes

- e11c60f: Three.js upstream docs now cover only the chosen framework bindings.

## 0.2.0

### Minor Changes

- cb34f11: Update refreshes kit-wired hook entries, hookFragment carries if/timeout/async, one merged Bash gate

### Patch Changes

- Updated dependencies [cb34f11]
  - @houserules/payload@0.2.0

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
