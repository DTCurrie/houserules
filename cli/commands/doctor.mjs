// `claude-kit doctor` (claude-kit CLI): validate an installation against reality.
// ERRORs (broken install) exit 1; WARNs (drift, advisories) exit 0.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { detect, trackedTemplateFiles } from '../detect.mjs';
import { MANIFEST_PATH } from '../apply.mjs';
import {
  listWorkspacePackages,
  readJson,
} from '../../payload/scripts/lib/workspaces.mjs';

// module id → hook script that must appear in a settings.json hook command.
const HOOK_SCRIPTS = {
  core: ['guard-bash.mjs'],
  'lint-fix': ['lint-format-fix.mjs'],
  changesets: ['changeset-check.mjs'],
  'session-context': ['session-context.mjs'],
  'debug-session': ['debug-session-check.mjs'],
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function allHookCommands(settings) {
  const commands = [];
  for (const groups of Object.values(settings?.hooks ?? {})) {
    for (const group of groups ?? []) {
      for (const hook of group?.hooks ?? [])
        commands.push(String(hook.command ?? ''));
    }
  }
  return commands;
}

export async function doctor(dir, flags) {
  const root = resolve(dir);
  const ctx = detect(root);
  const findings = [];
  const report = (level, msg) => findings.push({ level, msg });

  const [major] = process.versions.node.split('.').map(Number);
  if (major < 20) report('ERROR', `node ${process.versions.node} < 20`);
  if (!ctx.git.isRepo) report('ERROR', 'not a git work tree');

  const manifest = ctx.claude.manifest;
  if (!manifest) {
    report(
      'ERROR',
      `no ${MANIFEST_PATH} — kit not installed here (run: npx claude-kit init)`,
    );
  } else {
    if (manifest.kitVersion !== flags.kitVersion) {
      report(
        'WARN',
        `installed kit v${manifest.kitVersion}, this CLI is v${flags.kitVersion} — run: npx claude-kit update`,
      );
    }
    for (const [rel, expected] of Object.entries(manifest.files ?? {})) {
      const abs = join(root, rel);
      if (!existsSync(abs))
        report('ERROR', `kit file missing: ${rel} (update recreates it)`);
      else if (sha256(readFileSync(abs)) !== expected) {
        report(
          'WARN',
          `kit file locally edited: ${rel} (update will keep your version; --force overwrites)`,
        );
      }
    }
    // Reference templates that got committed before the kit ignored them.
    const strayTemplates = ctx.git.isRepo ? trackedTemplateFiles(root) : [];
    if (strayTemplates.length) {
      report(
        'WARN',
        `${strayTemplates.length} reference template(s) under .claude/kit-templates/ are committed (reference-only). Untrack, keeping them on disk: npx claude-kit update — or: git rm --cached -r .claude/kit-templates && git add .claude/kit-templates/.gitignore`,
      );
    }
  }

  // kit.config.json vs reality.
  const config = ctx.claude.kitConfig;
  if (!config) {
    report(manifest ? 'ERROR' : 'WARN', 'no .claude/kit.config.json');
  } else {
    if (config.version !== 2)
      report(
        'WARN',
        `kit.config.json version ${config.version ?? 1} (current schema: 2)`,
      );
    const workspaceNames = new Set(
      listWorkspacePackages(root).map((p) => p.name),
    );
    for (const target of config.targets ?? []) {
      if (target.pathPrefix && !existsSync(join(root, target.pathPrefix))) {
        report(
          'WARN',
          `target "${target.name}": pathPrefix ${target.pathPrefix} does not exist`,
        );
      }
      if (target.sourcePath && !existsSync(join(root, target.sourcePath))) {
        report(
          'WARN',
          `target "${target.name}": sourcePath ${target.sourcePath} does not exist`,
        );
      }
      if (
        workspaceNames.size &&
        target.packageName !== '.' &&
        !workspaceNames.has(target.packageName)
      ) {
        report(
          'WARN',
          `target "${target.name}": package ${target.packageName} not found in the workspace`,
        );
      }
      const pkgDir = target.pathPrefix ? join(root, target.pathPrefix) : root;
      const scripts = readJson(join(pkgDir, 'package.json'))?.scripts ?? {};
      for (const cmd of target.fixCommands ?? config.fix?.commands ?? []) {
        if (!scripts[cmd])
          report(
            'WARN',
            `target "${target.name}": fix script "${cmd}" not in ${target.pathPrefix || './'}package.json`,
          );
      }
    }
  }

  // Hooks wired?
  if (manifest && ctx.claude.settingsExists && !ctx.claude.settingsParseError) {
    const commands = allHookCommands(ctx.claude.settings);
    for (const moduleId of manifest.modules ?? []) {
      for (const scriptName of HOOK_SCRIPTS[moduleId] ?? []) {
        if (!commands.some((c) => c.includes(scriptName))) {
          report(
            'WARN',
            `module "${moduleId}": hook script ${scriptName} not wired in .claude/settings.json`,
          );
        }
      }
    }
  } else if (manifest && !ctx.claude.settingsExists) {
    report(
      'ERROR',
      'kit installed but .claude/settings.json is missing (hooks unwired) — rerun init',
    );
  }
  if (ctx.claude.settingsParseError)
    report(
      'ERROR',
      `.claude/settings.json unparseable: ${ctx.claude.settingsParseError}`,
    );
  if (ctx.claude.settingsLocalExists) {
    try {
      const local = JSON.parse(
        readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'),
      );
      const dupes = allHookCommands(local).filter((c) =>
        /(guard-bash|lint-format-fix|changeset-check|session-context|debug-session-check)\.mjs/.test(
          c,
        ),
      );
      if (dupes.length)
        report(
          'WARN',
          'settings.local.json also wires kit hook scripts — they will run twice',
        );
    } catch {
      /* local file is the user's business */
    }
  }

  // Changesets story.
  if (manifest?.modules?.includes('changesets')) {
    if (!ctx.changesets.configExists)
      report(
        'ERROR',
        'changesets module installed but .changeset/config.json is missing',
      );
    else if (ctx.changesets.invocation === 'external-cli') {
      report(
        'WARN',
        'changesets CLI not installed (pnpx/npx works; add @changesets/cli as a devDependency for release flows)',
      );
    }
  }

  // DRAFT agents left unfilled.
  for (const agentFile of ctx.claude.agents) {
    try {
      const text = readFileSync(
        join(root, '.claude', 'agents', agentFile),
        'utf8',
      );
      if (/^description:.*DRAFT/m.test(text))
        report(
          'WARN',
          `agent ${agentFile} is still a DRAFT — fill in its authoritative source`,
        );
    } catch {
      /* unreadable agent file — not the doctor's problem */
    }
  }

  if (manifest?.modules?.includes('rename') && !ctx.typescript) {
    report(
      'WARN',
      'rename module installed but no typescript dependency detected — rename.mjs will fail',
    );
  }

  const errors = findings.filter((f) => f.level === 'ERROR');
  const warns = findings.filter((f) => f.level === 'WARN');
  for (const f of findings)
    console.log(`${f.level === 'ERROR' ? '✗ ERROR' : '! WARN '}  ${f.msg}`);
  console.log(
    findings.length
      ? `\n${errors.length} error(s), ${warns.length} warning(s).`
      : '✓ kit installation healthy — no findings.',
  );
  return errors.length ? 1 : 0;
}
