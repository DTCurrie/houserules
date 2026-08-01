// Presentation + prompts (claude-kit CLI). All clack usage lives here; commands
// call these helpers so headless (--yes / non-TTY) paths never import a prompt.

import * as p from '@clack/prompts';
import pc from 'picocolors';
import type {
  AdviseAction,
  ChangesetInvocation,
  Ctx,
  Effect,
  EffectOp,
  ModuleDef,
  SettingsPlan,
  Target,
  WrittenEntry,
} from './types.js';

export const isTTY = () => Boolean(process.stdout.isTTY && process.stdin.isTTY);

// clack sizes a note box to its longest line, so one line wider than the terminal
// wraps and shreds the border — every multi-line string handed to note()/message()
// is wrapped first. Prose stops at 100 cols even on a very wide terminal.
const cols = () => Math.max(48, Math.min(process.stdout.columns || 80, 100));
const noteWidth = () => cols() - 8; // "│  " + content + "  │" + slack
const messageWidth = () => cols() - 4; // "│  " + content

// Word-wrap to `width`. Tokens are never split — paths, commands and flags have to
// stay copy-pasteable — so an over-long word just overflows its line. Width is
// measured on visible characters; a break inside a coloured span is closed with a
// reset so the colour can't bleed into the rest of the output.
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
// Code points, not display columns: a CJK character or emoji occupies two terminal
// cells but counts as one here, so a line of them under-measures and can overflow.
// Accepted — this wraps paths, flags and English prose. `string-width` fixes it for
// 4 packages / 104KB, which the audit judged not worth it.
const visible = (s: string) => s.replace(ANSI, '').length;
const hasAnsi = (s: string) => s.includes(`${ESC}[`);

export function wrap(text: string, width = messageWidth()): string {
  return String(text)
    .split('\n')
    .flatMap((line) => {
      const lead = /^[ \t]*/.exec(line)![0];
      const words = line.slice(lead.length).split(/\s+/).filter(Boolean);
      if (!words.length) return [''];
      const out: string[] = [];
      let current = lead + words[0];
      for (const word of words.slice(1)) {
        if (visible(current) + 1 + visible(word) <= width)
          current += ` ${word}`;
        else {
          out.push(hasAnsi(current) ? `${current}${ESC}[0m` : current);
          current = lead + word;
        }
      }
      out.push(current);
      return out;
    })
    .join('\n');
}

// "label  body", wrapped with the continuation lines hanging under the body column.
export function labelled(
  label: string,
  text: string,
  width = noteWidth(),
): string {
  const [first, ...rest] = wrap(text, width - label.length).split('\n');
  return [label + first, ...rest.map((l) => ' '.repeat(label.length) + l)].join(
    '\n',
  );
}

// Wrap BEFORE colouring: splitting an already-coloured string strands its reset
// code on the first line, bleeding colour into everything after it.
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

// One-line status in the flow, no box — for the many single-sentence notices that
// a box only makes harder to read.
export function message(text: string): void {
  const body = wrap(text, messageWidth());
  if (isTTY()) p.log.message(body);
  else console.log(body);
}

export function cancel(text: string): void {
  if (isTTY()) p.cancel(text);
  else console.error(text);
}

function bail<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    cancel('Cancelled — nothing written.');
    process.exit(1);
  }
  return value;
}

// A single unbreakable token (an absolute repo path) sets the whole box width, so
// long paths are elided from the LEFT — the tail is what identifies the repo.
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
      ? pc.yellow(`kit v${ctx.claude.manifest.kitVersion} already installed`)
      : null,
  ]
    .filter(Boolean)
    .join(', ');
  const row = (name: string, value: string) => labelled(name.padEnd(13), value);
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

export async function selectModules(
  modules: ModuleDef[],
  ctx: Ctx,
  preselectedIds: string[],
): Promise<string[]> {
  const options = modules.map((m) => ({
    value: m.id,
    label: m.locked ? `${m.title} ${pc.dim('(always)')}` : m.title,
    hint: `${m.group === 'experimental' ? 'EXPERIMENTAL — ' : ''}${m.hint(ctx)}`,
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

// Multiselect over not-yet-installed modules for `claude-kit modules`. Unlike
// selectModules this has no preselect and never force-adds core — it only offers
// what the repo does not already have; an empty pick is valid (nothing to add).
export async function selectNewModules(
  available: ModuleDef[],
  ctx: Ctx,
): Promise<string[]> {
  if (!available.length) return [];
  const options = available.map((m) => ({
    value: m.id,
    label: m.title,
    hint: `${m.group === 'experimental' ? 'EXPERIMENTAL — ' : ''}${m.hint(ctx)}`,
  }));
  return bail<string[]>(
    await p.multiselect({
      message: 'Modules to add (space toggles, enter confirms; none = cancel)',
      options,
      required: false,
    }),
  );
}

export async function confirmTargets(targets: Target[]): Promise<Target[]> {
  if (!targets.length) return targets;
  const rows = targets
    .map((t) =>
      labelled(
        `  ${t.name}  `,
        `prefix=${t.prefix}  src=${t.sourcePath || '(root)'}  fix=${t.fixCommands?.join('+') ?? '—'}`,
      ),
    )
    .join('\n');
  note(rows, 'Detected targets');
  const keep = bail<string[]>(
    await p.multiselect({
      message: 'Targets the kit should track',
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
        'Edit backlog prefixes now? (also editable later in kit.config.json)',
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
            /^[A-Z][A-Z0-9]*$/.test(v)
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
    'skip-modified',
    'skip-exists',
    'skip-identical',
  ];
  for (const op of order) {
    const matching = effects.filter((e) => e.op === op);
    if (!matching.length) continue;
    if (op === 'skip-identical' && matching.length > 3) {
      lines.push(pc.dim(`= ${matching.length} kit files already up to date`));
      continue;
    }
    for (const { action } of matching) {
      const [sigil, color] = OP_STYLE[op];
      const suffix =
        op === 'skip-exists'
          ? ' (exists — yours, untouched)'
          : op === 'skip-modified'
            ? ' (local edits — kept; update --force to overwrite)'
            : '';
      const regionSuffix = action.kind === 'region' ? ' (managed block)' : '';
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
          `± ${settingsPlan.dest} ${settingsPlan.existedBefore ? '(merge into existing; .bak kept)' : '(create)'}`,
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
      lines.push(pc.dim(`= ${settingsPlan.dest} already has every kit entry`));
    }
  }
  return lines.join('\n');
}

// Post-install to-dos. Printed OUTSIDE the plan box and last: they are long prose,
// and a box sized to the longest of them is unreadable at any terminal width.
export function nextSteps(advisories: AdviseAction[]): void {
  if (!advisories.length) return;
  const lines = advisories.map((a, i) =>
    labelled(`${String(i + 1).padStart(2)}. `, a.text, messageWidth()),
  );
  const body = `${pc.bold('Next steps (yours — the kit does not do these):')}\n\n${lines.join('\n')}`;
  if (isTTY()) p.log.message(body);
  else console.log(`\n${body}\n`);
}

export function renderWritten(written: WrittenEntry[]): string {
  if (!written.length) return 'Nothing to write — already up to date.';
  return written
    .map(
      (w) =>
        `${w.op === 'create' ? '+' : w.op === 'merge' ? '±' : '~'} ${w.dest}`,
    )
    .join('\n');
}

// The receipt. A long one is a verbatim repeat of the plan printed moments earlier,
// so past a handful of files it collapses to counts.
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
