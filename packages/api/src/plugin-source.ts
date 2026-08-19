/** Where a plugin came from and what houserules resolved it to. Recorded in the manifest. */
export interface PluginSource {
  /** The `name` from config: an npm package name or a repo-relative path. */
  name: string;
  /** The id namespace its modules are addressed under. */
  alias: string;
  /** From the resolved package.json. `unknown` when it declares none. */
  version: string;
  /** Absolute path to the resolved package directory. */
  dir: string;
}
