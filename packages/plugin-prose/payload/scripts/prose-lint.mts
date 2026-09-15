#!/usr/bin/env node
/**
 * Checks shipped markdown against the mechanical clauses of `prose-voice.md`.
 *
 * Only the clauses a script can decide alone land here. "No semicolons" is one, because a
 * semicolon in prose either is or is not there. The "never more than one em dash per
 * paragraph" sub-clause is another, a count. "American English" is a third, for the
 * spellings a fixed table names. Whether "where a period or comma works" is not, because
 * the qualifier is the whole clause, so it stays in the rule for a reader to apply.
 *
 * Probe 3b measured a naive version of this checker at zero true positives out of two
 * findings, and both failures were in the segmentation rather than the rule: a semicolon
 * inside a multi-line inline-code span, and a semicolon inside a blockquoted example that a
 * document quotes precisely in order to forbid it. That is why this reads prose through
 * `stripToProse` and never through its own regex.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { stripToProse } from '@houserules/payload/markdown-segment';
import {
  emptyReport,
  exitCodeFor,
  renderReport,
  type Finding,
  type Report,
} from '@houserules/payload/findings';

const DECLINED = [
  'whether a surviving em dash is a genuine, unreplaceable aside, a judgment the rule keeps',
  'filler words, measured unreliable and left to the rule',
  'sentence length and asides, which need a real tokenizer to split on',
  'a British spelling the fixed word list does not name, since no dictionary ships',
];

const EM_DASH = '—';

/**
 * British spellings the "American English" clause forbids, as fixed tables rather than a
 * blanket `-ise` or `-our` rule. `advertise`, `compromise`, `exercise`, `promise`, and
 * `glamour` are American spellings a blanket rule would flag, so each family names its
 * stems and the checker matches nothing outside them. Precision wins over recall here:
 * `analyses` stays out because it is also the American noun plural, and a spelling the
 * tables do not name is declined, not guessed.
 */

/** Verb stems spelled `-ise` in British English and `-ize` in American. Each ends in `is`. */
const ISE_STEMS = [
  'apologis',
  'authoris',
  'binaris',
  'canonicalis',
  'capitalis',
  'categoris',
  'centralis',
  'characteris',
  'civilis',
  'colonis',
  'computeris',
  'containeris',
  'criticis',
  'customis',
  'digitis',
  'discretis',
  'emphasis',
  'energis',
  'equalis',
  'externalis',
  'familiaris',
  'finalis',
  'generalis',
  'globalis',
  'harmonis',
  'hypothesis',
  'idealis',
  'immunis',
  'industrialis',
  'initialis',
  'internalis',
  'itemis',
  'jeopardis',
  'legalis',
  'liberalis',
  'linearis',
  'localis',
  'materialis',
  'maximis',
  'memois',
  'memoris',
  'minimis',
  'mobilis',
  'modernis',
  'modularis',
  'monetis',
  'nationalis',
  'neutralis',
  'normalis',
  'optimis',
  'organis',
  'parallelis',
  'parameteris',
  'parametris',
  'penalis',
  'personalis',
  'popularis',
  'pressuris',
  'prioritis',
  'privatis',
  'publicis',
  'quantis',
  'randomis',
  'rationalis',
  'realis',
  'recognis',
  'regularis',
  'revolutionis',
  'sanitis',
  'scrutinis',
  'sensitis',
  'serialis',
  'socialis',
  'specialis',
  'stabilis',
  'standardis',
  'sterilis',
  'subsidis',
  'summaris',
  'symbolis',
  'synchronis',
  'synthesis',
  'systematis',
  'theoris',
  'tokenis',
  'trivialis',
  'utilis',
  'vaporis',
  'vectoris',
  'verbalis',
  'victimis',
  'virtualis',
  'visualis',
  'vocalis',
];

/** Verb stems spelled `-yse` in British English. `es` is absent because `analyses` is a noun too. */
const YSE_STEMS = ['analys', 'catalys', 'paralys'];

/** Words spelled `-our` in British English and `-or` in American, with any prefix or suffix. */
const OUR_STEMS = [
  'armour',
  'behaviour',
  'candour',
  'clamour',
  'colour',
  'endeavour',
  'favour',
  'flavour',
  'harbour',
  'honour',
  'humour',
  'labour',
  'neighbour',
  'odour',
  'rigour',
  'rumour',
  'savour',
  'splendour',
  'tumour',
  'valour',
  'vapour',
  'vigour',
];

/** Words spelled `-re` in British English and `-er` in American, with any prefix and a plural. */
const RE_STEMS = ['centre', 'fibre', 'litre', 'meagre', 'metre', 'theatre'];

/** Stems whose final `l` doubles before a suffix in British English and stays single in American. */
const DOUBLED_L_STEMS = [
  'bevel',
  'cancel',
  'channel',
  'chisel',
  'council',
  'counsel',
  'dial',
  'equal',
  'fuel',
  'funnel',
  'grovel',
  'initial',
  'jewel',
  'label',
  'level',
  'marvel',
  'model',
  'panel',
  'parcel',
  'pedal',
  'pencil',
  'quarrel',
  'revel',
  'rival',
  'shovel',
  'signal',
  'spiral',
  'stencil',
  'swivel',
  'total',
  'travel',
  'trial',
  'tunnel',
  'unravel',
];

/** Whole words with no productive pattern, British to American. */
const EXACT: Record<string, string> = {
  acknowledgement: 'acknowledgment',
  acknowledgements: 'acknowledgments',
  aeroplane: 'airplane',
  aeroplanes: 'airplanes',
  ageing: 'aging',
  aluminium: 'aluminum',
  amongst: 'among',
  analogue: 'analog',
  analogues: 'analogs',
  artefact: 'artifact',
  artefacts: 'artifacts',
  catalogue: 'catalog',
  catalogues: 'catalogs',
  catalogued: 'cataloged',
  cataloguing: 'cataloging',
  centred: 'centered',
  centring: 'centering',
  centrepiece: 'centerpiece',
  cosy: 'cozy',
  cypher: 'cipher',
  cyphers: 'ciphers',
  defence: 'defense',
  defences: 'defenses',
  distil: 'distill',
  distils: 'distills',
  draught: 'draft',
  draughts: 'drafts',
  enquire: 'inquire',
  enquires: 'inquires',
  enquired: 'inquired',
  enquiring: 'inquiring',
  enquiry: 'inquiry',
  enquiries: 'inquiries',
  enrol: 'enroll',
  enrols: 'enrolls',
  enrolment: 'enrollment',
  enrolments: 'enrollments',
  fulfil: 'fulfill',
  fulfils: 'fulfills',
  fulfilment: 'fulfillment',
  grey: 'gray',
  greys: 'grays',
  greyed: 'grayed',
  greying: 'graying',
  greyish: 'grayish',
  greyscale: 'grayscale',
  instalment: 'installment',
  instalments: 'installments',
  instil: 'instill',
  instils: 'instills',
  jewellery: 'jewelry',
  judgement: 'judgment',
  judgements: 'judgments',
  leant: 'leaned',
  learnt: 'learned',
  licence: 'license',
  licences: 'licenses',
  manoeuvre: 'maneuver',
  manoeuvres: 'maneuvers',
  manoeuvred: 'maneuvered',
  manoeuvring: 'maneuvering',
  marvellous: 'marvelous',
  maths: 'math',
  mould: 'mold',
  moulds: 'molds',
  moulded: 'molded',
  moulding: 'molding',
  offence: 'offense',
  offences: 'offenses',
  orientate: 'orient',
  orientated: 'oriented',
  orientating: 'orienting',
  practise: 'practice',
  practises: 'practices',
  practised: 'practiced',
  practising: 'practicing',
  pretence: 'pretense',
  programme: 'program',
  programmes: 'programs',
  sceptic: 'skeptic',
  sceptics: 'skeptics',
  sceptical: 'skeptical',
  sceptically: 'skeptically',
  scepticism: 'skepticism',
  skilful: 'skillful',
  skilfully: 'skillfully',
  speciality: 'specialty',
  specialities: 'specialties',
  spoilt: 'spoiled',
  storey: 'story',
  storeys: 'stories',
  whilst: 'while',
  wilful: 'willful',
  wilfully: 'willfully',
  woollen: 'woolen',
};

const ISE_SUFFIX = '(?:e|es|ed|ing|er|ers|ation|ations|ational|ationally|able)';
const YSE_SUFFIX = '(?:e|ed|ing|er|ers)';
const DOUBLED_L_SUFFIX = '(?:ed|ing|er|ers|or|ors)';

const alternation = (items: string[]): string => `(?:${items.join('|')})`;

/** A whole-word, case-insensitive matcher for one family, with a group around its stem. */
const wordRegex = (body: string): RegExp => new RegExp(`\\b${body}\\b`, 'gi');

/** `word` with `length` characters at `index` replaced, every other letter kept as written. */
const swap = (
  word: string,
  index: number,
  length: number,
  replacement: string,
): string => word.slice(0, index) + replacement + word.slice(index + length);

/**
 * The `letters` that sit directly before a final `suffix`, anchored to the suffix rather
 * than to the first occurrence, since `visualised` and `disorganised` carry an earlier `is`.
 */
const lettersBefore = (letters: string, suffix: string): RegExp =>
  new RegExp(`${letters}(?=${suffix}$)`, 'i');

/** Swaps the letters `ending` finds in `word` for `replacement`. */
const swapEnding = (
  word: string,
  ending: RegExp,
  replacement: string,
): string => {
  const at = ending.exec(word);
  return at ? swap(word, at.index, at[0].length, replacement) : word;
};

/** The stem the regex matched on, since a whole-word match does not say where its stem sits. */
const stemIndex = (match: RegExpMatchArray): number =>
  match[0].toLowerCase().indexOf(match[1]!.toLowerCase());

const keepCapital = (from: string, to: string): string =>
  /^[A-Z]/.test(from) ? to[0]!.toUpperCase() + to.slice(1) : to;

interface SpellingFamily {
  regex: RegExp;
  /** The American form of a matched word, letters outside the swap kept byte for byte. */
  american(match: RegExpMatchArray): string;
}

const FAMILIES: SpellingFamily[] = [
  {
    regex: wordRegex(`[a-z]*(${alternation(ISE_STEMS)})${ISE_SUFFIX}`),
    american: (match) =>
      swapEnding(match[0], lettersBefore('is', ISE_SUFFIX), 'iz'),
  },
  {
    regex: wordRegex(`[a-z]*(${alternation(YSE_STEMS)})${YSE_SUFFIX}`),
    american: (match) =>
      swapEnding(match[0], lettersBefore('ys', YSE_SUFFIX), 'yz'),
  },
  {
    regex: wordRegex(`[a-z]*(${alternation(OUR_STEMS)})[a-z]*`),
    american: (match) =>
      swap(match[0], stemIndex(match) + match[1]!.length - 3, 3, 'or'),
  },
  {
    regex: wordRegex(`[a-z]*(${alternation(RE_STEMS)})s?`),
    american: (match) =>
      swap(match[0], stemIndex(match) + match[1]!.length - 2, 2, 'er'),
  },
  {
    regex: wordRegex(
      `[a-z]*(${alternation(DOUBLED_L_STEMS)})l${DOUBLED_L_SUFFIX}`,
    ),
    american: (match) =>
      swapEnding(match[0], lettersBefore('ll', DOUBLED_L_SUFFIX), 'l'),
  },
  {
    regex: wordRegex(`(${alternation(Object.keys(EXACT))})`),
    american: (match) => keepCapital(match[0], EXACT[match[0].toLowerCase()]!),
  },
];

/** A URL is exact content, so its path segments are never read as words. */
const URL_RE = /https?:\/\/\S+/g;

export interface BritishSpelling {
  word: string;
  american: string;
}

/** Every British spelling on one line of prose, in order, each with its American form. */
export function findBritishSpellings(line: string): BritishSpelling[] {
  const text = line.replace(URL_RE, (url) => ' '.repeat(url.length));
  const found: Array<BritishSpelling & { index: number }> = [];
  for (const family of FAMILIES) {
    for (const match of text.matchAll(family.regex)) {
      found.push({
        word: match[0],
        american: family.american(match),
        index: match.index!,
      });
    }
  }
  return found
    .sort((a, b) => a.index - b.index)
    .map(({ word, american }) => ({ word, american }));
}

function checkSpelling(file: string, prose: string): Finding[] {
  const findings: Finding[] = [];
  prose.split('\n').forEach((line, index) => {
    for (const { word, american } of findBritishSpellings(line)) {
      findings.push({
        rule: 'prose-voice/american-english',
        level: 'error',
        file,
        line: index + 1,
        msg: `British spelling "${word}". Write "${american}".`,
      });
    }
  });
  return findings;
}

/**
 * One `warn` finding per em dash, plus an `error` finding on any paragraph carrying two or
 * more. The rule permits one em dash per paragraph, so this counts rather than bans, and a
 * paragraph is a run of non-blank lines separated by a blank one.
 */
function checkEmDashes(file: string, prose: string): Finding[] {
  const findings: Finding[] = [];
  const lines = prose.split('\n');
  let paragraphLines: number[] = [];

  const closeParagraph = (): void => {
    if (paragraphLines.length < 2) {
      paragraphLines = [];
      return;
    }
    findings.push({
      rule: 'prose-voice/em-dash-density',
      level: 'error',
      file,
      line: paragraphLines[0]! + 1,
      msg: `${paragraphLines.length} em dashes in one paragraph (lines ${paragraphLines[0]! + 1}-${paragraphLines[paragraphLines.length - 1]! + 1}). Keep at most one per paragraph.`,
    });
    paragraphLines = [];
  };

  lines.forEach((line, index) => {
    if (line.trim() === '') {
      closeParagraph();
      return;
    }
    const count = line.split(EM_DASH).length - 1;
    for (let i = 0; i < count; i++) {
      findings.push({
        rule: 'prose-voice/em-dash-present',
        level: 'warn',
        file,
        line: index + 1,
        msg: 'Em dash present. Rewrite as a period or comma unless the aside genuinely needs it, and never more than one per paragraph.',
      });
      paragraphLines.push(index);
    }
  });
  closeParagraph();

  return findings;
}

function checkSemicolons(file: string, prose: string): Finding[] {
  const findings: Finding[] = [];
  prose.split('\n').forEach((line, index) => {
    if (!line.includes(';')) return;
    findings.push({
      rule: 'prose-voice/no-semicolons',
      level: 'error',
      file,
      line: index + 1,
      msg: 'Semicolon in prose. Use a period, or a comma with a conjunction.',
    });
  });
  return findings;
}

/** Findings for one file, keyed to the clause rather than to this checker. */
export function checkProse(file: string, markdown: string): Report {
  const report = emptyReport();
  const prose = stripToProse(markdown);
  report.findings.push(...checkSemicolons(file, prose));
  report.findings.push(...checkEmDashes(file, prose));
  report.findings.push(...checkSpelling(file, prose));
  return report;
}

function main(): void {
  const files = process.argv.slice(2);
  const report = emptyReport();
  report.declined.push(...DECLINED);
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    report.findings.push(...checkProse(file, text).findings);
  }
  process.stdout.write(`${renderReport(report)}\n`);
  process.exit(exitCodeFor(report));
}

// Both sides go through `realpathSync` before comparing, matching the pattern the other
// payload scripts use. `process.argv[1]` stays the literal invocation path while
// `import.meta.url` resolves through any symlink in its ancestry, so raw string comparison
// misses on any repo staged under a symlinked temp dir. Guarding this way is also what lets
// a test import `checkProse` without the module exiting the process on load.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main();
}
