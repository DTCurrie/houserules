import { renderTable } from './render-table.js';
import { weightedInput } from './token-usage.js';
import type {
  Corpus,
  FileUsage,
  MainRequest,
  SessionEvents,
} from './transcript-events.js';

/** One main-chain artifact episode, from the request that issued its first quickstart or publish through its last publish. */
interface ArtifactEpisode {
  /** The first 8 characters of the session id, as the token section prints it. */
  session: string;
  artifactCalls: number;
  commentCalls: number;
  publishes: number;
  requests: number;
  output: number;
  weightedInput: number;
  /** The weighted input of the whole session, the denominator for the episode's share. */
  sessionWeightedInput: number;
  /** The model on most of the episode's requests. */
  model?: string | undefined;
  wallMs?: number | undefined;
}

export interface ArtifactReport {
  episodes: ArtifactEpisode[];
}

const SESSION_PREFIX_LENGTH = 8;
const MS_PER_MINUTE = 60_000;
const PERCENT = 100;

interface ArtifactCall {
  ts?: number | undefined;
  isPublish: boolean;
  isQuickstart: boolean;
}

/** A publish is `action: publish`, or an `Artifact` call that names no action. */
function mainArtifactCalls(session: SessionEvents): ArtifactCall[] {
  return session.toolUses
    .filter((use) => use.name === 'Artifact' && !use.isSidechain)
    .map((use) => ({
      ts: use.ts,
      isPublish: use.action === undefined || use.action === 'publish',
      isQuickstart: use.action === 'quickstart',
    }));
}

/** The first and last timestamp the calls carry, or `undefined` when none carries one. */
function callWindow(
  calls: ArtifactCall[],
): { start: number; end: number } | undefined {
  const publishes = calls.filter((call) => call.isPublish);
  const quickstart = calls.find((call) => call.isQuickstart);
  const stamped = (list: ArtifactCall[]) =>
    list.flatMap((call) => (call.ts === undefined ? [] : [call.ts]));
  const all = stamped(calls);
  if (all.length === 0) return undefined;
  if (publishes.length === 0)
    return { start: Math.min(...all), end: Math.max(...all) };
  const publishTimes = stamped(publishes);
  const startFrom = quickstart?.ts ?? publishTimes[0];
  return {
    start: startFrom ?? Math.min(...all),
    end: publishTimes.length ? Math.max(...publishTimes) : Math.max(...all),
  };
}

/**
 * The timestamp of the request that issued a call stamped `callTs`. A request is stamped by its
 * first content block, so it starts before its own tool_use block: the issuing request is the
 * last one stamped at or before the call.
 */
function issuingRequestTs(
  requests: MainRequest[],
  callTs: number,
): number | undefined {
  let issuing: number | undefined;
  for (const request of requests)
    if (
      request.ts !== undefined &&
      request.ts <= callTs &&
      (issuing === undefined || request.ts > issuing)
    )
      issuing = request.ts;
  return issuing;
}

function majorityModel(requests: MainRequest[]): string | undefined {
  const counts = new Map<string, number>();
  for (const request of requests)
    if (request.model)
      counts.set(request.model, (counts.get(request.model) ?? 0) + 1);
  let best: string | undefined;
  let bestCount = 0;
  for (const [model, count] of counts)
    if (count > bestCount) {
      best = model;
      bestCount = count;
    }
  return best;
}

function episodeOf(
  sessionId: string,
  session: SessionEvents,
  file: FileUsage | undefined,
): ArtifactEpisode | undefined {
  const calls = mainArtifactCalls(session);
  if (calls.length === 0) return undefined;
  const window = callWindow(calls);
  const start =
    window &&
    (issuingRequestTs(session.mainRequests, window.start) ?? window.start);
  const inside = session.mainRequests.filter(
    (request) =>
      window !== undefined &&
      start !== undefined &&
      request.ts !== undefined &&
      request.ts >= start &&
      request.ts <= window.end,
  );
  const times = inside.flatMap((request) =>
    request.ts === undefined ? [] : [request.ts],
  );
  return {
    session: sessionId.slice(0, SESSION_PREFIX_LENGTH),
    artifactCalls: calls.length,
    commentCalls: session.toolUses.filter(
      (use) => use.name === 'ArtifactComments' && !use.isSidechain,
    ).length,
    publishes: calls.filter((call) => call.isPublish).length,
    requests: inside.length,
    output: inside.reduce((sum, request) => sum + request.output, 0),
    weightedInput: inside.reduce(
      (sum, request) => sum + weightedInput(request),
      0,
    ),
    sessionWeightedInput: file ? weightedInput(file) : 0,
    model: majorityModel(inside),
    wallMs: times.length ? Math.max(...times) - Math.min(...times) : undefined,
  };
}

/** Every artifact episode in the corpus, one per main chain that called `Artifact`. */
export function computeArtifactEpisodes(corpus: Corpus): ArtifactReport {
  const filesBySession = new Map(
    corpus.files.map((file) => [file.file.replace(/\.jsonl$/, ''), file]),
  );
  const episodes: ArtifactEpisode[] = [];
  for (const [sessionId, session] of corpus.sessions) {
    const episode = episodeOf(
      sessionId,
      session,
      filesBySession.get(sessionId),
    );
    if (episode) episodes.push(episode);
  }
  return { episodes };
}

const formatCount = (value: number) => value.toLocaleString('en-US');

function formatShare(part: number, whole: number): string {
  return whole === 0 ? 'n/a' : `${((PERCENT * part) / whole).toFixed(1)}%`;
}

function formatWall(wallMs: number | undefined): string {
  return wallMs === undefined
    ? 'n/a'
    : `${(wallMs / MS_PER_MINUTE).toFixed(1)} min`;
}

/** The artifact section. A document exported before the section existed renders nothing. */
export function renderArtifactEpisodes(
  report: ArtifactReport | undefined,
): string[] {
  if (!report) return [];
  const heading = '-- artifact episodes --';
  if (report.episodes.length === 0)
    return [heading, '  No Artifact calls were recorded.'];
  return [
    heading,
    ...renderTable(
      [
        'session',
        'calls',
        'comments',
        'publishes',
        'requests',
        'wall',
        'output',
        'weighted-in',
        'share of session',
        'model',
      ],
      report.episodes.map((episode) => [
        episode.session,
        episode.artifactCalls,
        episode.commentCalls,
        episode.publishes,
        episode.requests,
        formatWall(episode.wallMs),
        formatCount(episode.output),
        formatCount(episode.weightedInput),
        formatShare(episode.weightedInput, episode.sessionWeightedInput),
        episode.model ?? 'n/a',
      ]),
    ),
  ];
}
