/** A parsed semantic version: the three release numbers and the dot-split prerelease identifiers. */
interface Semver {
  release: number[];
  prerelease: string[];
}

/**
 * Parses `1.2.3`, `v1.2.3`, `1.2.3-beta.1`, and `1.2.3+build.5`. Build metadata is dropped,
 * since it carries no precedence.
 *
 * @returns The parsed version, or null when the string is not semver.
 */
export function parseSemver(version: string): Semver | null {
  const match =
    /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      version.trim(),
    );
  if (!match) return null;
  return {
    release: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

/** Semver precedence of two prerelease identifiers: numeric ones compare as numbers and sort first. */
function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Semver precedence: numeric release parts first, then a prerelease sorts below its release.
 *
 * @returns Negative when `left` sorts below `right`, zero when equal, positive when above.
 */
export function compareSemver(left: Semver, right: Semver): number {
  for (let i = 0; i < left.release.length; i++) {
    const difference = left.release[i]! - right.release[i]!;
    if (difference !== 0) return difference;
  }
  if (!left.prerelease.length || !right.prerelease.length)
    return right.prerelease.length - left.prerelease.length;
  const shared = Math.min(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < shared; i++) {
    const difference = compareIdentifiers(
      left.prerelease[i]!,
      right.prerelease[i]!,
    );
    if (difference !== 0) return difference;
  }
  return left.prerelease.length - right.prerelease.length;
}
