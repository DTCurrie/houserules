import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';

/**
 * Parse `pmset -g batt` output.
 * @param {string} text
 * @returns {'ac' | 'battery' | 'unknown'}
 */
export function parsePmset(text) {
  const pmsetOutput = String(text ?? '');
  if (pmsetOutput.includes('AC Power')) return 'ac';
  if (pmsetOutput.includes('Battery Power')) return 'battery';
  return 'unknown';
}

const PMSET_TIMEOUT_MS = 5000;

function readPowerDarwin() {
  const result = spawnSync('pmset', ['-g', 'batt'], {
    encoding: 'utf8',
    timeout: PMSET_TIMEOUT_MS,
  });
  return parsePmset(result.stdout);
}

function readPowerLinux() {
  const base = '/sys/class/power_supply';
  let sawMains = false;
  for (const name of readdirSync(base)) {
    let type = '';
    try {
      type = readFileSync(`${base}/${name}/type`, 'utf8').trim();
    } catch {
      // no type file: fall through to the online check
    }
    if (type && type !== 'Mains') continue;
    try {
      const online = readFileSync(`${base}/${name}/online`, 'utf8').trim();
      sawMains = true;
      if (online === '1') return 'ac';
    } catch {
      // not a supply with an online flag
    }
  }
  return sawMains ? 'battery' : 'unknown';
}

function readPower() {
  try {
    if (process.platform === 'darwin') return readPowerDarwin();
    if (process.platform === 'linux') return readPowerLinux();
  } catch {
    // fall through
  }
  return 'unknown';
}

function safe(fn) {
  try {
    const value = fn();
    return value === undefined || value === null || value === ''
      ? 'unknown'
      : value;
  } catch {
    return 'unknown';
  }
}

/**
 * Facts about the machine and build under measurement. Never throws.
 * @param {string} commit full sha of the measured build
 */
export function machineFacts(commit) {
  return {
    node: safe(() => process.version),
    cpu: safe(() => os.cpus()[0].model),
    cpus: safe(() => os.cpus().length || undefined),
    os: safe(() => `${os.platform()} ${os.release()}`),
    arch: safe(() => os.arch()),
    power: safe(readPower),
    commit,
  };
}
