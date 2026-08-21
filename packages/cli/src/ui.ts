import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { AdviseAction } from '@houserules/api';
import type { WrittenEntry } from './apply.js';
import { BACKUP_DIR } from './core/fs-target.js';
import type { ChangesetInvocation, Ctx, Target } from './detect.js';
import type { SettingsPlan } from '@houserules/api/internal';
import type { Effect, EffectOp } from './plan.js';
import type { RegisteredModule } from './plugin-registry.js';

const isTTY = () => Boolean(process.stdout.isTTY && process.stdin.isTTY);

// clack sizes a note box to its longest line, so one line wider than the terminal
// wraps and shreds the border. Every multi-line string is wrapped before note().
const MIN_COLS = 48;
const DEFAULT_COLS = 80;
const MAX_COLS = 100;
const cols = () =>
  Math.max(
    MIN_COLS,
    Math.min(process.stdout.columns || DEFAULT_COLS, MAX_COLS),
  );
const noteWidth = () => cols() - 8; // "│  " + content + "  │" + slack
const messageWidth = () => cols() - 4; // "│  " + content

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
// Code points, not display columns, so a line of CJK or emoji under-measures and can
// overflow. Accepted: `string-width` fixes it for 4 packages and 104KB.
const visible = (s: string) => s.replace(ANSI, '').length;
const hasAnsi = (s: string) => s.includes(`${ESC}[`);

// A bullet or numbered marker opening a line. Held with its first word rather than treated
// as a word of its own, so an over-long item cannot strand it on a line by itself.
const LIST_MARKER = /^(?:[-*+]|\d+\.)[ \t]+/;

/**
 * Word-wraps to `width`, measured on visible characters so ANSI codes do not count. A
 * token is never split, because paths, commands, and flags have to stay copy-pasteable,
 * so an over-long word overflows its line. A break inside a colored span is closed
 * with a reset so the color cannot bleed into the rest of the output.
 *
 * A list marker stays on the same line as its first word, and continuation lines hang
 * under that word. Treating the marker as an ordinary word let an item longer than `width`
 * push its text to the next line, leaving a bare `-` above it that reads as truncated
 * output. An absolute path in a bullet does that on any normal terminal.
 */
export function wrap(text: string, width = messageWidth()): string {
  return String(text)
    .split('\n')
    .flatMap((line) => {
      const lead = /^[ \t]*/.exec(line)![0];
      const body = line.slice(lead.length);
      const marker = LIST_MARKER.exec(body)?.[0] ?? '';
      const words = body.slice(marker.length).split(/\s+/).filter(Boolean);
      if (!words.length) return marker ? [(lead + marker).trimEnd()] : [''];
      // Continuation lines align under the first word, not under the marker.
      const hang = lead + ' '.repeat(visible(marker));
      const out: string[] = [];
      let current = lead + marker + words[0];
      for (const word of words.slice(1)) {
        if (visible(current) + 1 + visible(word) <= width)
          current += ` ${word}`;
        else {
          out.push(hasAnsi(current) ? `${current}${ESC}[0m` : current);
          current = hang + word;
        }
      }
      out.push(current);
      return out;
    })
    .join('\n');
}

/** Renders "label  body", hanging the wrapped continuation lines under the body column. */
export function labeled(
  label: string,
  text: string,
  width = noteWidth(),
): string {
  const [first, ...rest] = wrap(text, width - label.length).split('\n');
  return [label + first, ...rest.map((l) => ' '.repeat(label.length) + l)].join(
    '\n',
  );
}

// Wrap BEFORE coloring: splitting an already-colored string strands its reset
// code on the first line, bleeding color into everything after it.
function bullet(
  text: string,
  width: number,
  color: (s: string) => string,
): string[] {
  return wrap(text, width - 2)
    .split('\n')
    .map((line, i) => color(i === 0 ? line : `  ${line}`));
}

export function intro(text: string): void {
  if (isTTY()) p.intro(pc.inverse(` ${text} `));
  else console.log(`\n=== ${text} ===`);
}

export function outro(text: string): void {
  if (isTTY()) p.outro(text);
  else console.log(`\n${text}\n`);
}

export function note(text: string, title?: string): void {
  if (isTTY()) p.note(text, title);
  else console.log(`\n-- ${title ?? ''} --\n${text}\n`);
}

/** One-line status in the flow, no box. A box only makes a single sentence harder to read. */
export function message(text: string): void {
  const body = wrap(text, messageWidth());
  if (isTTY()) p.log.message(body);
  else console.log(body);
}

function cancel(text: string): void {
  if (isTTY()) p.cancel(text);
  else console.error(text);
}

function bail<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    cancel('Canceled — nothing written.');
    process.exit(1);
  }
  return value;
}

// A single unbreakable token (an absolute repo path) sets the whole box width, so
// long paths are elided from the LEFT. The tail is what identifies the repo.
function elideStart(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(-(max - 1))}`;
}

export function profileCard(ctx: Ctx): string {
  const pm = ctx.packageManager
    ? `${ctx.packageManager.name}${ctx.packageManager.version ? `@${ctx.packageManager.version}` : ''} (${ctx.packageManager.source})`
    : 'none (no package.json)';
  const pkgs = ctx.packages.length
    ? ctx.packages.map((x) => `${x.name} (${x.relDir})`).join(', ')
    : ctx.rootPkg
      ? `single package: ${ctx.rootPkg.name ?? '(unnamed)'}`
      : 'no JS packages';
  const fixes = ctx.targets
    .map(
      (t) =>
        `${t.name} → ${t.fixCommands ? t.fixCommands.join('+') : pc.dim('none')}`,
    )
    .join(', ');
  const cs = ctx.changesets;
  const changesets = cs.configExists
    ? `config ✓, ${cs.pendingCount} pending, CLI: ${
        (
          {
            devdep: 'devDependency',
            'root-script': `root script "${cs.rootScript}"`,
            'external-cli': pc.yellow('not installed (pnpx/npx works)'),
            // `absent` is unreachable here: this branch is guarded by cs.configExists.
          } as Partial<Record<ChangesetInvocation, string>>
        )[cs.invocation]
      }, base ${cs.baseBranch}`
    : 'not set up';
  const claudeBits = [
    ctx.claude.settingsExists ? 'settings.json' : null,
    ctx.claude.settingsLocalExists
      ? 'settings.local.json (never touched)'
      : null,
    ctx.claude.claudeMdExists ? 'CLAUDE.md' : pc.dim('no CLAUDE.md'),
    ctx.claude.manifest
      ? pc.yellow(
          `houserules v${ctx.claude.manifest.kitVersion} already installed`,
        )
      : null,
  ]
    .filter(Boolean)
    .join(', ');
  const row = (name: string, value: string) => labeled(name.padEnd(13), value);
  return [
    row('repo', elideStart(ctx.root, noteWidth() - 13)),
    row('package mgr', pm),
    row('packages', pkgs),
    row('typescript', ctx.typescript ? 'yes' : 'no'),
    row('fix scripts', fixes || pc.dim('n/a')),
    row('changesets', changesets),
    row('.claude', claudeBits || pc.dim('absent')),
  ].join('\n');
}

/** A namespaced label suffix so a plugin-contributed module reads as such in the picker. */
function pluginTag(m: RegisteredModule): string {
  return m.source ? ` ${pc.dim(`[${m.source.alias}]`)}` : '';
}

export async function selectModules(
  modules: RegisteredModule[],
  ctx: Ctx,
  preselectedIds: string[],
): Promise<string[]> {
  const options = modules.map((m) => ({
    value: m.id,
    label: `${m.def.locked ? `${m.def.title} ${pc.dim('(always)')}` : m.def.title}${pluginTag(m)}`,
    hint: `${m.def.group === 'experimental' ? 'EXPERIMENTAL — ' : ''}${m.def.hint(ctx)}`,
  }));
  const picked = bail<string[]>(
    await p.multiselect({
      message: 'Modules to install (space toggles, enter confirms)',
      options,
      initialValues: [...new Set(['core', ...preselectedIds])],
      required: true,
    }),
  );
  return picked.includes('core') ? picked : ['core', ...picked];
}

/**
 * Multiselect over the modules the repo does not already have, for `houserules modules`.
 * Unlike `selectModules` it has no preselect and never force-adds core, and an empty pick
 * is valid.
 */
export async function selectNewModules(
  available: RegisteredModule[],
  ctx: Ctx,
): Promise<string[]> {
  if (!available.length) return [];
  const options = available.map((m) => ({
    value: m.id,
    label: `${m.def.title}${pluginTag(m)}`,
    hint: `${m.def.group === 'experimental' ? 'EXPERIMENTAL — ' : ''}${m.def.hint(ctx)}`,
  }));
  return bail<string[]>(
    await p.multiselect({
      message: 'Modules to add (space toggles, enter confirms; none = cancel)',
      options,
      required: false,
    }),
  );
}

/**
 * Prefixes a module's follow-up question with the module asking it, and with the plugin that
 * module came from.
 *
 * The questions are asked back to back, one per option-bearing module, and a question phrased
 * as "install the slim variant instead?" says nothing about which install it means. Installing
 * two plugins that each ask something leaves the user guessing which answer lands where.
 * `def.id` rather than the registry's namespaced id, since the alias is already in the tag.
 */
export function optionPromptMessage(
  m: RegisteredModule,
  prompt: string,
): string {
  return `${pc.dim(m.def.id)}${pluginTag(m)}  ${prompt}`;
}

/**
 * Asks each enabled module's follow-up question, in order. A module with no `options`
 * declaration is skipped, and a run where nothing is enabled with options asks nothing.
 *
 * @param resolved The non-interactive resolution from `resolveModuleOptions`, used to
 *   preselect each multiselect so an already-installed choice survives a re-run.
 */
export async function selectModuleOptions(
  modules: RegisteredModule[],
  resolved: Record<string, string[]>,
): Promise<Record<string, string[]>> {
  const answers: Record<string, string[]> = { ...resolved };
  for (const m of modules) {
    const options = m.def.options;
    if (!options) continue;
    const picked = bail<string[]>(
      await p.multiselect({
        message: optionPromptMessage(m, options.prompt),
        options: options.choices.map((choice) => ({
          value: choice.value,
          label: choice.label,
          hint: choice.hint,
        })),
        initialValues: resolved[m.id] ?? [...options.defaults],
        required: false,
      }),
    );
    answers[m.id] = picked;
  }
  return answers;
}

export async function confirmTargets(targets: Target[]): Promise<Target[]> {
  if (!targets.length) return targets;
  const rows = targets
    .map((t) =>
      labeled(
        `  ${t.name}  `,
        `prefix=${t.prefix}  src=${t.sourcePath || '(root)'}  fix=${t.fixCommands?.join('+') ?? '—'}`,
      ),
    )
    .join('\n');
  note(rows, 'Detected targets');
  const keep = bail<string[]>(
    await p.multiselect({
      message: 'Targets houserules should track',
      options: targets.map((t) => ({
        value: t.name,
        label: `${t.name} (${t.packageName})`,
      })),
      initialValues: targets.map((t) => t.name),
      required: false,
    }),
  );
  const kept = targets.filter((t) => keep.includes(t.name));
  const editPrefixes = bail<boolean>(
    await p.confirm({
      message:
        'Edit backlog prefixes now? (also editable later in houserules.config.json)',
      initialValue: false,
    }),
  );
  if (editPrefixes) {
    for (const t of kept) {
      const value = bail<string>(
        await p.text({
          message: `Prefix for ${t.name}`,
          initialValue: t.prefix,
          validate: (v) =>
            /^[A-Z][A-Z0-9]*$/.test(v ?? '')
              ? undefined
              : 'uppercase ASCII, e.g. CORE',
        }),
      );
      t.prefix = value;
    }
  }
  return kept;
}

export async function confirm(message: string): Promise<boolean> {
  return bail<boolean>(await p.confirm({ message, initialValue: true }));
}

type OpStyleKey = Exclude<EffectOp, 'delete'> | 'merge';

const OP_STYLE: Record<OpStyleKey, [string, (s: string) => string]> = {
  create: ['+', pc.green],
  update: ['~', pc.yellow],
  merge: ['±', pc.cyan],
  'skip-identical': ['=', pc.dim],
  'skip-exists': ['•', pc.dim],
  'skip-modified': ['!', pc.red],
};

export function renderPreview({
  effects,
  settingsPlan,
}: {
  effects: Effect[];
  settingsPlan: SettingsPlan | null;
}): string {
  const width = noteWidth();
  const lines: string[] = [];
  const order: OpStyleKey[] = [
    'create',
    'update',
    'merge',
    'skip-modified',
    'skip-exists',
    'skip-identical',
  ];
  for (const op of order) {
    const matching = effects.filter((e) => e.op === op);
    if (!matching.length) continue;
    if (op === 'skip-identical' && matching.length > 3) {
      lines.push(
        pc.dim(`= ${matching.length} houserules files already up to date`),
      );
      continue;
    }
    for (const { action } of matching) {
      const [sigil, color] = OP_STYLE[op];
      const suffix =
        op === 'skip-exists'
          ? ' (exists — yours, untouched)'
          : op === 'skip-modified'
            ? ' (local edits — kept. Update --force to overwrite)'
            : '';
      const regionSuffix =
        action.kind === 'region'
          ? ' (managed block)'
          : action.kind === 'body'
            ? ' (managed body)'
            : '';
      lines.push(
        ...bullet(
          `${sigil} ${action.dest}${regionSuffix}${suffix}`,
          width,
          color,
        ),
      );
    }
  }
  if (settingsPlan) {
    if (settingsPlan.changes.length) {
      lines.push(
        ...bullet(
          `± ${settingsPlan.dest} ${settingsPlan.existedBefore ? `(merge into existing; backup kept in ${BACKUP_DIR}/)` : '(create)'}`,
          width,
          OP_STYLE.merge[1],
        ),
      );
      for (const change of settingsPlan.changes) {
        lines.push(
          ...bullet(`    + ${change.kind}: ${change.detail}`, width, pc.cyan),
        );
      }
    } else {
      lines.push(
        pc.dim(`= ${settingsPlan.dest} already has every houserules entry`),
      );
    }
  }
  return lines.join('\n');
}

/**
 * Prints the post-install to-dos, outside the plan box and last. They are long prose, and
 * a box sized to the longest of them is unreadable at any terminal width.
 */
export function nextSteps(advisories: AdviseAction[]): void {
  if (!advisories.length) return;
  const lines = advisories.map((a, i) =>
    labeled(`${String(i + 1).padStart(2)}. `, a.text, messageWidth()),
  );
  const body = `${pc.bold('Next steps (yours — houserules does not do these):')}\n\n${lines.join('\n')}`;
  if (isTTY()) p.log.message(body);
  else console.log(`\n${body}\n`);
}

function renderWritten(written: WrittenEntry[]): string {
  if (!written.length) return 'Nothing to write — already up to date.';
  return written
    .map(
      (w) =>
        `${w.op === 'create' ? '+' : w.op === 'merge' ? '±' : '~'} ${w.dest}`,
    )
    .join('\n');
}

/**
 * Prints the receipt. A long one repeats the plan shown moments earlier verbatim, so past
 * a handful of files it collapses to counts.
 */
export function written(list: WrittenEntry[]): void {
  if (!list.length) {
    message('Nothing written — already up to date.');
    return;
  }
  if (list.length <= 6) {
    note(renderWritten(list), 'Written');
    return;
  }
  const count = (op: WrittenEntry['op']) =>
    list.filter((w) => w.op === op).length;
  const parts = [
    ['created', count('create')],
    ['updated', count('update')],
    ['merged', count('merge')],
  ]
    .filter(([, n]) => n)
    .map(([label, n]) => `${n} ${label}`);
  const breakdown = parts.length > 1 ? ` — ${parts.join(', ')}` : '';
  message(`Wrote ${list.length} files${breakdown} (listed above).`);
}
