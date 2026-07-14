// Presentation + prompts (claude-kit CLI). All clack usage lives here; commands
// call these helpers so headless (--yes / non-TTY) paths never import a prompt.

import * as p from '@clack/prompts';
import pc from 'picocolors';

export const isTTY = () => Boolean(process.stdout.isTTY && process.stdin.isTTY);

export function intro(text) {
  if (isTTY()) p.intro(pc.inverse(` ${text} `));
  else console.log(`\n=== ${text} ===`);
}

export function outro(text) {
  if (isTTY()) p.outro(text);
  else console.log(`\n${text}\n`);
}

export function note(text, title) {
  if (isTTY()) p.note(text, title);
  else console.log(`\n-- ${title ?? ''} --\n${text}\n`);
}

export function cancel(text) {
  if (isTTY()) p.cancel(text);
  else console.error(text);
}

function bail(value) {
  if (p.isCancel(value)) {
    cancel('Cancelled — nothing written.');
    process.exit(1);
  }
  return value;
}

export function profileCard(ctx) {
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
        {
          devdep: 'devDependency',
          'root-script': `root script "${cs.rootScript}"`,
          'external-cli': pc.yellow('not installed (pnpx/npx works)'),
        }[cs.invocation]
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
  return [
    `repo         ${ctx.root}`,
    `package mgr  ${pm}`,
    `packages     ${pkgs}`,
    `typescript   ${ctx.typescript ? 'yes' : 'no'}`,
    `fix scripts  ${fixes || pc.dim('n/a')}`,
    `changesets   ${changesets}`,
    `.claude      ${claudeBits || pc.dim('absent')}`,
  ].join('\n');
}

export async function selectModules(modules, ctx, preselectedIds) {
  const options = modules.map((m) => ({
    value: m.id,
    label: m.locked ? `${m.title} ${pc.dim('(always)')}` : m.title,
    hint: `${m.group === 'experimental' ? 'EXPERIMENTAL — ' : ''}${m.hint(ctx)}`,
  }));
  const picked = bail(
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
export async function selectNewModules(available, ctx) {
  if (!available.length) return [];
  const options = available.map((m) => ({
    value: m.id,
    label: m.title,
    hint: `${m.group === 'experimental' ? 'EXPERIMENTAL — ' : ''}${m.hint(ctx)}`,
  }));
  return bail(
    await p.multiselect({
      message: 'Modules to add (space toggles, enter confirms; none = cancel)',
      options,
      required: false,
    }),
  );
}

export async function confirmTargets(targets) {
  if (!targets.length) return targets;
  const rows = targets
    .map(
      (t) =>
        `  ${t.name}  prefix=${t.prefix}  src=${t.sourcePath || '(root)'}  fix=${t.fixCommands?.join('+') ?? '—'}`,
    )
    .join('\n');
  note(rows, 'Detected targets');
  const keep = bail(
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
  let kept = targets.filter((t) => keep.includes(t.name));
  const editPrefixes = bail(
    await p.confirm({
      message:
        'Edit backlog prefixes now? (also editable later in kit.config.json)',
      initialValue: false,
    }),
  );
  if (editPrefixes) {
    for (const t of kept) {
      const value = bail(
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

export async function confirm(message) {
  return bail(await p.confirm({ message, initialValue: true }));
}

const OP_STYLE = {
  create: ['+', pc.green],
  update: ['~', pc.yellow],
  merge: ['±', pc.cyan],
  'skip-identical': ['=', pc.dim],
  'skip-exists': ['•', pc.dim],
  'skip-modified': ['!', pc.red],
};

export function renderPreview({ effects, settingsPlan, advisories }) {
  const lines = [];
  const order = [
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
      const label =
        op === 'skip-exists'
          ? `${action.dest} ${pc.dim('(exists — yours, untouched)')}`
          : op === 'skip-modified'
            ? `${action.dest} ${pc.dim('(local edits — kept; update --force to overwrite)')}`
            : action.dest;
      lines.push(color(`${sigil} ${label}`));
    }
  }
  if (settingsPlan) {
    if (settingsPlan.changes.length) {
      lines.push(
        OP_STYLE.merge[1](
          `± ${settingsPlan.dest} ${settingsPlan.existedBefore ? '(merge into existing; .bak kept)' : '(create)'}`,
        ),
      );
      for (const change of settingsPlan.changes) {
        lines.push(pc.cyan(`    + ${change.kind}: ${change.detail}`));
      }
    } else {
      lines.push(pc.dim(`= ${settingsPlan.dest} already has every kit entry`));
    }
  }
  if (advisories.length) {
    lines.push('', pc.bold('Next steps (yours — the kit does not do these):'));
    advisories.forEach((a, i) => lines.push(`  ${i + 1}. ${a.text}`));
  }
  return lines.join('\n');
}

export function renderWritten(written) {
  if (!written.length) return 'Nothing to write — already up to date.';
  return written
    .map(
      (w) =>
        `${w.op === 'create' ? '+' : w.op === 'merge' ? '±' : '~'} ${w.dest}`,
    )
    .join('\n');
}
