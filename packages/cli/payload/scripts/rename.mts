#!/usr/bin/env node
/**
 * Semantic rename via the TypeScript LanguageService, the scriptable equivalent of VS
 * Code's Rename Symbol. Renames a symbol and every reference to it, including
 * `@link` targets in TSDoc comments, across the file's tsconfig project.
 *
 * TypeScript repos only. It hard-fails at import without the `typescript` package.
 *
 * Usage:
 *   node .claude/scripts/rename.mjs <file>:<line>:<col> <newName> [--dry-run]
 *
 * <line> and <col> are 1-based and must land on the identifier. Scope is the nearest
 * tsconfig.json above <file>, so a cross-package symbol is renamed only within its own
 * package. Verify with the package's typecheck afterwards.
 */
import path from 'node:path';
import process from 'node:process';

import ts from 'typescript';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const [locArg, newName] = args.filter((a) => !a.startsWith('--'));

// A declaration rather than the file's usual `const` arrow on purpose. TypeScript applies
// never-return narrowing through a hoisted declaration, and not through a module-scope const
// assigned before its call sites, so the arrow form leaves locArg and newName widened below.
function usage(): never {
  console.error(
    'usage: node .claude/scripts/rename.mjs <file>:<line>:<col> <newName> [--dry-run]\n' +
      '  <line>/<col> are 1-based and must point at the identifier (e.g. from `grep -n`).',
  );
  process.exit(2);
}

if (!locArg || !newName) usage();

// Parse `file:line:col` from the right so posix paths (no colons) stay intact.
const parts = locArg.split(':');
const col = Number(parts.pop());
const line = Number(parts.pop());
const file = path.resolve(parts.join(':'));
if (!Number.isFinite(line) || !Number.isFinite(col)) usage();

const findTsconfig = (start: string): string | undefined => {
  let dir = path.dirname(start);
  for (;;) {
    const candidate = path.join(dir, 'tsconfig.json');
    if (ts.sys.fileExists(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
};

const configPath = findTsconfig(file);
if (!configPath) {
  console.error(`no tsconfig.json found above ${file}`);
  process.exit(1);
}

const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(
  configFile.config,
  ts.sys,
  path.dirname(configPath),
);

const fileNames = new Set(parsed.fileNames.map((f) => path.resolve(f)));
fileNames.add(file);

const host = {
  getScriptFileNames: () => [...fileNames],
  getScriptVersion: () => '0',
  getScriptSnapshot: (f: string) => {
    const text = ts.sys.readFile(f);
    return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
  },
  getCurrentDirectory: () => process.cwd(),
  getCompilationSettings: () => parsed.options,
  getDefaultLibFileName: (o: ts.CompilerOptions) => ts.getDefaultLibFilePath(o),
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory,
  directoryExists: ts.sys.directoryExists,
  getDirectories: ts.sys.getDirectories,
};

const service = ts.createLanguageService(host, ts.createDocumentRegistry());
const source = service.getProgram()?.getSourceFile(file);
if (!source) {
  console.error(
    `target file is not part of the project (${configPath}): ${file}`,
  );
  process.exit(1);
}

const position = source.getPositionOfLineAndCharacter(line - 1, col - 1);
const locations = service.findRenameLocations(file, position, false, false, {
  providePrefixAndSuffixTextForRename: true,
});

if (!locations || locations.length === 0) {
  console.error(
    `no renameable symbol at ${path.relative(process.cwd(), file)}:${line}:${col}`,
  );
  process.exit(1);
}

const byFile = new Map<string, ts.RenameLocation[]>();
const skipped: string[] = [];
for (const loc of locations) {
  const f = path.resolve(loc.fileName);
  if (f.includes('node_modules') || f.endsWith('.d.ts')) {
    skipped.push(f);
    continue;
  }
  if (!byFile.has(f)) byFile.set(f, []);
  byFile.get(f)!.push(loc);
}

let total = 0;
let links = 0;
const report: string[] = [];
for (const [f, locs] of byFile) {
  const original = ts.sys.readFile(f);
  if (original === undefined) continue;
  locs.sort((a, b) => b.textSpan.start - a.textSpan.start);
  let text = original;
  for (const loc of locs) {
    const start = loc.textSpan.start;
    const end = start + loc.textSpan.length;
    const isLink = text.slice(Math.max(0, start - 7), start).includes('{@link');
    if (isLink) links++;
    if (dryRun) {
      const ctx = original
        .slice(Math.max(0, start - 24), end + 12)
        .replace(/\n/g, '⏎');
      report.push(`    ${isLink ? '{@link} ' : ''}…${ctx}…`);
    }
    text =
      text.slice(0, start) +
      (loc.prefixText ?? '') +
      newName +
      (loc.suffixText ?? '') +
      text.slice(end);
    total++;
  }
  if (!dryRun && text !== original) ts.sys.writeFile(f, text);
  report.push(`  ${path.relative(process.cwd(), f)}  ×${locs.length}`);
}

console.log(
  `${dryRun ? '[dry-run] would rename' : 'renamed'} → ${newName}: ${total} location(s) across ${byFile.size} file(s)` +
    (links ? `, incl. ${links} {@link} ref(s)` : ''),
);
for (const r of report) console.log(r);
if (skipped.length) {
  console.log(
    `  (skipped ${skipped.length} location(s) in node_modules/.d.ts)`,
  );
}
if (!dryRun) {
  const pkgDir = path.dirname(configPath);
  console.log(
    `verify: typecheck the package at ${path.relative(process.cwd(), pkgDir)}`,
  );
}
