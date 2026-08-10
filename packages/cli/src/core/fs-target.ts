import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The one filesystem seam for a target repo. `apply.ts` writes through it and the drift
 * engine reads through it, so "what a run would touch" and "what a run did touch" are
 * computed by the same code.
 *
 * `dryRun` is honored here rather than at every call site. A dry run still answers
 * read/exists truthfully and still reports what it would write, but it never lands bytes.
 */
export class TargetRepo {
  readonly root: string;
  readonly dryRun: boolean;

  // Explicit fields rather than parameter properties: `erasableSyntaxOnly` is on so
  // every .ts in the kit stays runnable under node's type stripping.
  constructor(root: string, dryRun = false) {
    this.root = root;
    this.dryRun = dryRun;
  }

  path(relativePath: string): string {
    return join(this.root, relativePath);
  }

  exists(relativePath: string): boolean {
    return existsSync(this.path(relativePath));
  }

  /** File text, or null when it is missing or unreadable. */
  read(relativePath: string): string | null {
    try {
      return readFileSync(this.path(relativePath), 'utf8');
    } catch (error) {
      this.warnIfUnreadable(relativePath, error);
      return null;
    }
  }

  /** Raw bytes, or null when missing. Used where content is compared by hash. */
  readBytes(relativePath: string): Buffer | null {
    try {
      return readFileSync(this.path(relativePath));
    } catch (error) {
      this.warnIfUnreadable(relativePath, error);
      return null;
    }
  }

  // Missing (ENOENT) is the common, expected case for both callers. Anything else, most
  // often a permission problem on a file that does exist, means a comparison against `null`
  // (treated as "no current file") is comparing against the wrong thing, silently.
  private warnIfUnreadable(relativePath: string, error: unknown): void {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(
        `agent-kit: could not read ${relativePath} (${(error as Error).message}). Treating it as if it does not exist.`,
      );
    }
  }

  /**
   * Returns false when the file already holds exactly this content. Mtimes stay
   * put, and a dry run reports only the paths a real run would change.
   */
  write(
    relativePath: string,
    content: Buffer | string,
    mode?: number,
  ): boolean {
    const next = Buffer.isBuffer(content)
      ? content
      : Buffer.from(content, 'utf8');
    const current = this.readBytes(relativePath);
    if (current !== null && current.equals(next)) return false;
    if (this.dryRun) return true;
    const absolute = this.path(relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    // Replace a symlink, never write through it. writeFileSync follows the link, landing
    // bytes on its target outside our tree, usually the payload source. Only git shows the damage.
    if (lstatSync(absolute, { throwIfNoEntry: false })?.isSymbolicLink()) {
      rmSync(absolute);
    }
    writeFileSync(absolute, next);
    if (mode !== undefined) chmodSync(absolute, mode);
    return true;
  }

  remove(relativePath: string): void {
    if (this.dryRun) return;
    rmSync(this.path(relativePath), { force: true });
  }

  /**
   * One-shot backup: copies `relativePath` to `<path>.bak` unless a backup is
   * already there. Taken once, before the kit's first write to a file the user
   * owns. A second run must not overwrite the pristine original.
   */
  backupOnce(relativePath: string): void {
    if (this.dryRun) return;
    const source = this.path(relativePath);
    const backup = `${source}.bak`;
    if (!existsSync(source) || existsSync(backup)) return;
    copyFileSync(source, backup);
  }
}
