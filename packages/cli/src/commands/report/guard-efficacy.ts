import type { Corpus } from './transcript-events.js';
import { isCrash } from './hook-crash.js';

export interface GuardBlock {
  session: string;
  blockedCommand: string;
}

export function computeGuardBlocks(corpus: Corpus): GuardBlock[] {
  const blocks: GuardBlock[] = [];
  for (const [sessionId, session] of corpus.sessions) {
    for (const fire of session.hookFires) {
      if (!fire.hookName.startsWith('PreToolUse')) continue;
      if (!fire.exitCode || isCrash(fire)) continue;
      const knownIndex =
        fire.toolUseID !== undefined
          ? session.toolUseIndexById.get(fire.toolUseID)
          : undefined;
      const blocked =
        knownIndex !== undefined ? session.toolUses[knownIndex] : undefined;
      blocks.push({
        session: sessionId.slice(0, 8),
        blockedCommand: blocked?.command ?? '(tool_use not found)',
      });
    }
  }
  return blocks;
}

export function renderGuardEfficacy(blocks: GuardBlock[]): string[] {
  const lines = ['-- guard efficacy --', ''];
  if (blocks.length === 0) {
    lines.push(
      '  no genuine blocks in this corpus (every non-zero PreToolUse exit was a hook crash)',
    );
    return lines;
  }
  for (const block of blocks)
    lines.push(`  ${block.session}  blocked: ${block.blockedCommand}`);
  return lines;
}
