const TAGS = new Set(['quality', 'efficiency']);
const ACTIONS = new Set(['fix-now', 'adopt', 'backlog', 'park', 'reject']);
const PHASE_ACTIONS = new Set(['fix-now', 'adopt']);
const REQUIRED = [
  'tag',
  'surface',
  'evidence',
  'version gate',
  'candidate action',
  'destination',
  'cost',
];
const FINDING_START = /^### (?=[A-Z]{2}-\d{2} )/m;
const ID_PREFIX_LENGTH = 'XX-'.length;
const ID_NUMBER_WIDTH = 2;
const ID_LENGTH = ID_PREFIX_LENGTH + ID_NUMBER_WIDTH;
const EVIDENCE_QUOTE_LENGTH = 60;

/** One `### XX-NN` block: its id, its title line, and every `- **key:** value` line by key. */
export interface ParsedFinding {
  id: string;
  title: string;
  fields: Map<string, string[]>;
}

/** Splits a report into its finding blocks, in file order. */
export function parseFindings(text: string): ParsedFinding[] {
  return text
    .split(FINDING_START)
    .slice(1)
    .map((block) => {
      const fields = new Map<string, string[]>();
      for (const match of block.matchAll(/^- \*\*([a-z ]+):\*\* (.*)$/gm)) {
        const key = match[1] as string;
        fields.set(key, [
          ...(fields.get(key) ?? []),
          (match[2] as string).trim(),
        ]);
      }
      const titleLine = block.split('\n')[0] as string;
      return {
        id: block.slice(0, ID_LENGTH),
        title: titleLine.slice(ID_LENGTH).trim(),
        fields,
      };
    });
}

/** Every `### XX-NN` finding id in a report, in file order. */
export function findingIds(text: string): string[] {
  return [...text.matchAll(/^### ([A-Z]{2}-\d{2}) /gm)].map(
    (match) => match[1] as string,
  );
}

function checkActionPairing(
  id: string,
  action: string | undefined,
  destination: string | undefined,
  destinations: ReadonlySet<string>,
): string[] {
  if (action === undefined || destination === undefined) return [];
  if (!ACTIONS.has(action) || !destinations.has(destination)) return [];
  const namesPhase = destination !== 'none';
  if (PHASE_ACTIONS.has(action) && !namesPhase)
    return [`${id}: ${action} must name a phase, not none`];
  if (!PHASE_ACTIONS.has(action) && namesPhase)
    return [`${id}: ${action} must name none, not ${destination}`];
  return [];
}

function checkEvidence(id: string, lines: readonly string[]): string[] {
  return lines
    .filter((line) => !/https?:\/\//.test(line) && !/`[^`]+`/.test(line))
    .map(
      (line) =>
        `${id}: evidence has no URL and no command: ${line.slice(0, EVIDENCE_QUOTE_LENGTH)}`,
    );
}

function checkBlock(
  finding: ParsedFinding,
  destinations: ReadonlySet<string>,
): string[] {
  const { id, fields } = finding;
  const defects: string[] = [];
  for (const key of REQUIRED)
    if (!fields.has(key)) defects.push(`${id}: missing ${key}`);
  const tag = fields.get('tag')?.[0];
  if (tag !== undefined && !TAGS.has(tag)) defects.push(`${id}: tag "${tag}"`);
  const action = fields.get('candidate action')?.[0];
  if (action !== undefined && !ACTIONS.has(action))
    defects.push(`${id}: candidate action "${action}"`);
  const destination = fields.get('destination')?.[0];
  if (destination !== undefined && !destinations.has(destination))
    defects.push(`${id}: destination "${destination}"`);
  defects.push(...checkActionPairing(id, action, destination, destinations));
  defects.push(...checkEvidence(id, fields.get('evidence') ?? []));
  return defects;
}

/**
 * Block defects for one report: missing or invalid fields, destination pairing, evidence,
 * id numbering, and the empty-report statement. Each string names its finding.
 */
export function checkFindings(
  text: string,
  destinations: ReadonlySet<string>,
): string[] {
  const findings = parseFindings(text);
  const defects = findings.flatMap((finding) =>
    checkBlock(finding, destinations),
  );
  findings.forEach(({ id }, index) => {
    const expected = String(index + 1).padStart(ID_NUMBER_WIDTH, '0');
    if (id.slice(ID_PREFIX_LENGTH) !== expected)
      defects.push(
        `${id}: numbering gap, expected ${id.slice(0, ID_PREFIX_LENGTH)}${expected}`,
      );
  });
  if (findings.length === 0 && !/zero findings|no findings/i.test(text))
    defects.push('no findings and no statement of why');
  return defects;
}

/** The lines printed per file: a count line, then each defect indented two spaces. */
export function formatFileResult(
  path: string,
  findingCount: number,
  defects: readonly string[],
): string {
  return [
    `${path}: ${findingCount} finding(s), ${defects.length} defect(s)`,
    ...defects.map((defect) => `  ${defect}`),
  ].join('\n');
}
