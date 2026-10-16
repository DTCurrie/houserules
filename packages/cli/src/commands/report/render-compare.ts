import type { ReportDocument } from './report-document.js';
import { renderTable } from './render-table.js';
import { weightedInput } from './token-usage.js';

type Row = [metric: string, ...values: (string | number)[]];

const MISSING = '-';

const formatCount = (value: number) => value.toLocaleString('en-US');

const sum = (values: number[]) =>
  values.reduce((total, value) => total + value, 0);

function row(
  metric: string,
  documents: ReportDocument[],
  value: (document: ReportDocument) => number,
): Row {
  return [metric, ...documents.map((document) => formatCount(value(document)))];
}

/** One row per name in the union across documents, `-` where a document never saw the name. */
function unionRows(
  documents: ReportDocument[],
  names: (document: ReportDocument) => Map<string, number>,
  metric: (name: string) => string,
): Row[] {
  const perDocument = documents.map(names);
  const all = [
    ...new Set(perDocument.flatMap((map) => [...map.keys()])),
  ].sort();
  return all.map((name) => [
    metric(name),
    ...perDocument.map((map) => {
      const found = map.get(name);
      return found === undefined ? MISSING : formatCount(found);
    }),
  ]);
}

function tokenRows(documents: ReportDocument[]): Row[] {
  return [
    row('sessions', documents, (doc) => doc.meta.sessions),
    row('turns', documents, (doc) => doc.tokens.totals.turns),
    row('fresh input', documents, (doc) => doc.tokens.totals.input),
    row('output', documents, (doc) => doc.tokens.totals.output),
    row('cache read', documents, (doc) => doc.tokens.totals.cacheRead),
    row('cache write', documents, (doc) => doc.tokens.totals.cacheWrite),
    row('weighted-in', documents, (doc) =>
      sum(doc.tokens.files.map((file) => weightedInput(file))),
    ),
    row(
      'sidechain turns',
      documents,
      (doc) => doc.tokens.totals.sidechainTurns,
    ),
    row('tool results', documents, (doc) => doc.tokens.totals.toolResults),
  ];
}

function hookRows(documents: ReportDocument[]): Row[] {
  const total =
    (pick: 'fires' | 'nonZero' | 'crashes' | 'blocks') =>
    (doc: ReportDocument) =>
      sum(doc.hooks.rows.map((hook) => hook[pick]));
  return [
    row('fires', documents, total('fires')),
    row('non-zero', documents, total('nonZero')),
    row('crashes', documents, total('crashes')),
    row('blocks', documents, total('blocks')),
    row('bash calls', documents, (doc) => doc.hooks.bashCalls),
    ...unionRows(
      documents,
      (doc) => new Map(doc.hooks.rows.map((hook) => [hook.hook, hook.fires])),
      (hook) => `fires: ${hook}`,
    ),
  ];
}

function skillRows(documents: ReportDocument[]): Row[] {
  return [
    row(
      'toolset-active sessions',
      documents,
      (doc) => doc.skills.toolsetActiveSessions,
    ),
    row('total sessions', documents, (doc) => doc.skills.totalSessions),
    ...unionRows(
      documents,
      (doc) =>
        new Map(
          doc.skills.counts.map((count) => [
            count.skill,
            count.model + count.user,
          ]),
        ),
      (skill) => `${skill} (model+user)`,
    ),
  ];
}

function outcomeRows(documents: ReportDocument[]): Row[] {
  const ledgerValue = (pick: 'fires' | 'matched') => (doc: ReportDocument) =>
    new Map(doc.outcomes.ledgers.map((ledger) => [ledger.skill, ledger[pick]]));
  const fires = unionRows(
    documents,
    ledgerValue('fires'),
    (skill) => `${skill} fires`,
  );
  const matched = unionRows(
    documents,
    ledgerValue('matched'),
    (skill) => `${skill} matched`,
  );
  const ledgerRows = fires.flatMap((firesRow, index) => [
    firesRow,
    matched[index] as Row,
  ]);
  return [
    row('changeset fires', documents, (doc) => doc.outcomes.changesets.fires),
    row('changeset exact', documents, (doc) => doc.outcomes.changesets.exact),
    row(
      'changeset windowed',
      documents,
      (doc) => doc.outcomes.changesets.windowed,
    ),
    ...ledgerRows,
  ];
}

function frictionRows(documents: ReportDocument[]): Row[] {
  return [
    row(
      'compacted sessions',
      documents,
      (doc) => doc.friction.compactedSessions.length,
    ),
    row('interrupts', documents, (doc) => doc.friction.interrupts),
    row('denials', documents, (doc) => doc.friction.denials.length),
    row('retry runs', documents, (doc) => doc.friction.retryRuns.length),
    row('bulk tool bytes', documents, (doc) =>
      sum(doc.friction.bulkByTool.map((tool) => tool.bytes)),
    ),
  ];
}

function residentRows(documents: ReportDocument[]): Row[] {
  return [
    row('recorded sessions', documents, (doc) => doc.residentContext.recorded),
    row(
      'median resident bytes',
      documents,
      (doc) => doc.residentContext.medianResidentBytes,
    ),
    row(
      'median ~tokens',
      documents,
      (doc) => doc.residentContext.medianEstimatedTokens,
    ),
  ];
}

/** Renders the documents as one table per section, one value column per `meta.label`. */
export function renderComparison(documents: ReportDocument[]): string[] {
  const headers = ['metric', ...documents.map((doc) => doc.meta.label)];
  const sections: [title: string, rows: Row[]][] = [
    ['tokens', tokenRows(documents)],
    ['hook health', hookRows(documents)],
    ['guard efficacy', [row('blocks', documents, (doc) => doc.guard.length)]],
    ['skill adoption', skillRows(documents)],
    ['skill outcomes', outcomeRows(documents)],
    ['friction', frictionRows(documents)],
    ['resident context', residentRows(documents)],
  ];
  return sections.flatMap(([title, rows]) => [
    `-- ${title} --`,
    '',
    ...renderTable(headers, rows),
    '',
  ]);
}
