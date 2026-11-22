import type { Corpus } from './transcript-events.js';

/** One session's kit version and where it came from. */
interface KitVersionRow {
  sessionId: string;
  version: string;
  /** `banner` is the SessionStart line. `recorded` is the repo's recorded version. */
  source: 'banner' | 'recorded';
}

export interface KitVersionsReport {
  rows: KitVersionRow[];
}

/**
 * Attributes each session to the kit version its SessionStart banner named. A session
 * without the line takes `recordedVersion`.
 */
export function computeKitVersions(
  corpus: Corpus,
  recordedVersion: string,
): KitVersionsReport {
  return {
    rows: corpus.files.map((file): KitVersionRow => {
      const sessionId = file.file.replace(/\.jsonl$/, '');
      const banner = corpus.kitVersions.get(sessionId);
      return banner === undefined
        ? { sessionId, version: recordedVersion, source: 'recorded' }
        : { sessionId, version: banner, source: 'banner' };
    }),
  };
}

/** Renders nothing for an absent report, as a document exported before the section has none. */
export function renderKitVersions(
  report: KitVersionsReport | undefined,
): string[] {
  if (!report || report.rows.length === 0) return [];
  const counts = new Map<string, number>();
  for (const row of report.rows) {
    const label =
      row.source === 'recorded' ? `${row.version} (recorded)` : row.version;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [
    '-- kit versions --',
    '',
    ...[...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([label, count]) => `  ${label}: ${count} session(s)`),
  ];
}
