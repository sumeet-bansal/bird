import { randomUUID } from 'node:crypto';
import { addFeatureOverrides } from './runtime-features.js';
import { parseMissingFeatureFlags, truncateErrorBody } from './twitter-client-base.js';
import { TWITTER_API_BASE } from './twitter-client-constants.js';
import { buildArticleFieldToggles, buildTweetDetailFeatures } from './twitter-client-features.js';

export const CAPTURE_SCHEMA_VERSION = 1;
export const CONSERVATIVE_RETRY_DELAY_MS = 60_000;

export type CaptureOperation = 'Likes' | 'TweetDetail';
export type CaptureHttpMethod = 'GET' | 'POST';
export type CaptureOutcome = 'ok' | 'paused' | 'error';

export type CapturedResponse = {
  schemaVersion: 1;
  requestId: string;
  attemptId: string;
  operation: CaptureOperation;
  queryId: string;
  method: CaptureHttpMethod;
  variables: Record<string, unknown>;
  fetchedAt: string;
  status: number;
  headers: Record<string, string>;
  body: string;
};

export type CaptureManifest = {
  schemaVersion: 1;
  requestId: string;
  operation: CaptureOperation;
  outcome: CaptureOutcome;
  responses: string[];
  attemptCount: number;
  finalResponse?: string;
  error?: string;
  errorKind?: string;
  retryAt?: string;
};

export type PageResult = {
  outcome: CaptureOutcome;
  retryAt?: string;
  response?: CapturedResponse;
  envelope?: unknown;
  error?: string;
  errorKind?: string;
  attemptCount: number;
};

export type BeforeAttemptInfo = {
  operation: CaptureOperation;
  queryId: string;
  method: CaptureHttpMethod;
  variables: Record<string, unknown>;
  attemptIndex: number;
};

export type BeforeAttemptDecision =
  | { action: 'proceed' }
  | { action: 'pause'; retryAt?: string; error?: string; errorKind?: string }
  | { action: 'error'; error: string; errorKind?: string };

export type BeforeAttemptGate = (info: BeforeAttemptInfo) => Promise<BeforeAttemptDecision> | BeforeAttemptDecision;
export type OnResponse = (response: CapturedResponse) => Promise<void>;

export type RawPageHooks = {
  requestId: string;
  beforeAttempt?: BeforeAttemptGate;
  onResponse?: OnResponse;
};

export function pageResultWithoutTransport(result: Omit<PageResult, 'attemptCount'>): PageResult {
  return { ...result, attemptCount: 0 };
}

export type GraphqlPageTransport = {
  fetchWithTimeout: (url: string, init: RequestInit) => Promise<Response>;
  getHeaders: () => Record<string, string>;
  refreshQueryIds: () => Promise<void>;
};

type AttemptHttpResult = {
  kind: 'http';
  captured: CapturedResponse;
  envelope?: unknown;
};

type AttemptPausedResult = {
  kind: 'paused';
  retryAt?: string;
  error?: string;
  errorKind?: string;
  captured?: CapturedResponse;
};

type AttemptErrorSource = 'gate' | 'transport' | 'persist';

type AttemptErrorResult = {
  kind: 'error';
  error: string;
  errorKind: string;
  captured?: CapturedResponse;
  source?: AttemptErrorSource;
};

type AttemptResult = AttemptHttpResult | AttemptPausedResult | AttemptErrorResult;

const LIKES_FALLBACK_QUERY_ID = 'JR2gceKucIKcVNB_9JkhsA';
const TWEET_DETAIL_FALLBACK_QUERY_IDS = ['97JF30KziU00483E_8elBA', 'aFvUsJm2c-oDkJV75blV6g'] as const;
const WHOLE_NON_NEGATIVE_INTEGER_PATTERN = /^\d+$/;
const HTTP_IMF_FIXDATE_PATTERN =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

export function buildLikesPageVariables(userId: string, count: number, cursor?: string): Record<string, unknown> {
  return {
    userId,
    count,
    includePromotedContent: false,
    withClientEventToken: false,
    withBirdwatchNotes: false,
    withVoice: true,
    ...(cursor ? { cursor } : {}),
  };
}

export function buildTweetDetailPageVariables(tweetId: string, cursor?: string): Record<string, unknown> {
  return {
    focalTweetId: tweetId,
    with_rux_injections: false,
    rankingMode: 'Relevance',
    includePromotedContent: true,
    withCommunity: true,
    withQuickPromoteEligibilityTweetFields: true,
    withBirdwatchNotes: true,
    withVoice: true,
    ...(cursor ? { cursor } : {}),
  };
}

export function buildTweetDetailPageFeatures(): Record<string, boolean> {
  return {
    ...buildTweetDetailFeatures(),
    articles_preview_enabled: true,
    articles_rest_api_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    rweb_video_timestamps_enabled: true,
  };
}

export function buildTweetDetailPageFieldToggles(): Record<string, boolean> {
  return {
    ...buildArticleFieldToggles(),
    withArticleRichContentState: true,
  };
}

export async function resolveLikesQueryIds(getQueryId: (name: 'Likes') => Promise<string>): Promise<string[]> {
  const primary = await getQueryId('Likes');
  return Array.from(new Set([primary, LIKES_FALLBACK_QUERY_ID]));
}

export async function resolveTweetDetailQueryIds(
  getQueryId: (name: 'TweetDetail') => Promise<string>,
): Promise<string[]> {
  const primary = await getQueryId('TweetDetail');
  return Array.from(new Set([primary, ...TWEET_DETAIL_QUERY_FALLBACKS]));
}

const TWEET_DETAIL_QUERY_FALLBACKS = TWEET_DETAIL_FALLBACK_QUERY_IDS;

export function pickCaptureHeaders(headers: Headers | Record<string, string> | undefined): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const [key, value] of headerEntries(headers)) {
    const lower = key.toLowerCase();
    if (
      lower === 'content-type' ||
      lower === 'content-length' ||
      lower === 'retry-after' ||
      lower.startsWith('x-rate-limit-')
    ) {
      selected[lower] = value;
    }
  }
  return selected;
}

function parseWholeNonNegativeInteger(value: string): number | undefined {
  if (!WHOLE_NON_NEGATIVE_INTEGER_PATTERN.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return undefined;
  }
  return parsed;
}

function representableDate(ms: number): Date | undefined {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date;
}

export function retryAtIso(date: Date, nowMs = Date.now()): string {
  if (Number.isNaN(date.getTime())) {
    return conservativeRetryAt(nowMs).toISOString();
  }
  return date.toISOString();
}

export function parseRetryAt(headers: Record<string, string>, nowMs = Date.now()): Date | undefined {
  const retryAfter = headers['retry-after'];
  if (retryAfter) {
    const trimmed = retryAfter.trim();
    const deltaSeconds = parseWholeNonNegativeInteger(trimmed);
    if (deltaSeconds !== undefined) {
      return representableDate(nowMs + deltaSeconds * 1000) ?? conservativeRetryAt(nowMs);
    }
    if (HTTP_IMF_FIXDATE_PATTERN.test(trimmed)) {
      const httpDate = representableDate(Date.parse(trimmed));
      if (!httpDate || httpDate.getTime() <= nowMs) {
        return conservativeRetryAt(nowMs);
      }
      return httpDate;
    }
  }

  const reset = headers['x-rate-limit-reset'];
  if (reset) {
    const epoch = parseWholeNonNegativeInteger(reset.trim());
    const resetDate = epoch === undefined ? undefined : representableDate(epoch * 1000);
    if (!resetDate || resetDate.getTime() <= nowMs) {
      return conservativeRetryAt(nowMs);
    }
    return resetDate;
  }

  return undefined;
}

export function conservativeRetryAt(nowMs = Date.now()): Date {
  return new Date(nowMs + CONSERVATIVE_RETRY_DELAY_MS);
}

function headerEntries(headers: Headers | Record<string, string> | undefined): Array<[string, string]> {
  if (!headers) {
    return [];
  }
  if (typeof (headers as Headers).entries === 'function') {
    return Array.from((headers as Headers).entries());
  }
  return Object.entries(headers as Record<string, string>);
}

function parseEnvelope(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function graphqlErrorMessage(envelope: unknown): string | undefined {
  if (!envelope || typeof envelope !== 'object') {
    return undefined;
  }
  const errors = (envelope as { errors?: Array<{ message?: string }> }).errors;
  if (!Array.isArray(errors) || errors.length === 0) {
    return undefined;
  }
  return errors.map((entry) => entry.message ?? '').join(', ');
}

export function getLikesInstructions(envelope: unknown): unknown[] | undefined {
  if (!envelope || typeof envelope !== 'object') {
    return undefined;
  }
  const instructions = (
    envelope as {
      data?: { user?: { result?: { timeline?: { timeline?: { instructions?: unknown[] } } } } };
    }
  ).data?.user?.result?.timeline?.timeline?.instructions;
  return Array.isArray(instructions) ? instructions : undefined;
}

export function getTweetDetailData(envelope: unknown): {
  tweetResult?: { result?: unknown };
  threaded_conversation_with_injections_v2?: { instructions?: unknown[] };
} {
  if (!envelope || typeof envelope !== 'object') {
    return {};
  }
  const data = (envelope as { data?: Record<string, unknown> }).data;
  if (!data || typeof data !== 'object') {
    return {};
  }
  return data as {
    tweetResult?: { result?: unknown };
    threaded_conversation_with_injections_v2?: { instructions?: unknown[] };
  };
}

export function hasUsablePageData(operation: CaptureOperation, envelope: unknown): boolean {
  if (operation === 'Likes') {
    return getLikesInstructions(envelope) !== undefined;
  }
  const data = getTweetDetailData(envelope);
  return Boolean(data.tweetResult?.result || data.threaded_conversation_with_injections_v2?.instructions?.length);
}

function featureHealSource(captured: CapturedResponse, envelope?: unknown): string {
  if (captured.status !== 200) {
    return `HTTP ${captured.status}: ${truncateErrorBody(captured.body)}`;
  }
  return graphqlErrorMessage(envelope) ?? '';
}

export async function executeGraphqlAttempt(
  transport: Pick<GraphqlPageTransport, 'fetchWithTimeout' | 'getHeaders'>,
  spec: {
    operation: CaptureOperation;
    queryId: string;
    method: CaptureHttpMethod;
    variables: Record<string, unknown>;
    features: Record<string, boolean>;
    fieldToggles?: Record<string, boolean>;
    requestId: string;
    attemptIndex: number;
  },
  hooks: {
    beforeAttempt?: BeforeAttemptGate;
    onResponse?: OnResponse;
    onAdmitted?: () => void;
  },
): Promise<AttemptResult> {
  if (hooks.beforeAttempt) {
    let decision: BeforeAttemptDecision;
    try {
      decision = await hooks.beforeAttempt({
        operation: spec.operation,
        queryId: spec.queryId,
        method: spec.method,
        variables: spec.variables,
        attemptIndex: spec.attemptIndex,
      });
    } catch (error) {
      return {
        kind: 'error',
        error: error instanceof Error ? error.message : String(error),
        errorKind: 'gate_error',
        source: 'gate',
      };
    }

    if (decision.action === 'pause') {
      return {
        kind: 'paused',
        retryAt: decision.retryAt,
        error: decision.error,
        errorKind: decision.errorKind,
      };
    }
    if (decision.action === 'error') {
      return {
        kind: 'error',
        error: decision.error,
        errorKind: decision.errorKind ?? 'gate_error',
        source: 'gate',
      };
    }
  }

  const params = new URLSearchParams({
    variables: JSON.stringify(spec.variables),
    features: JSON.stringify(spec.features),
    ...(spec.fieldToggles ? { fieldToggles: JSON.stringify(spec.fieldToggles) } : {}),
  });
  const endpointPath = `${TWITTER_API_BASE}/${spec.queryId}/${spec.operation}`;
  const url = spec.method === 'GET' ? `${endpointPath}?${params.toString()}` : endpointPath;
  const init: RequestInit =
    spec.method === 'GET'
      ? { method: 'GET', headers: transport.getHeaders() }
      : {
          method: 'POST',
          headers: transport.getHeaders(),
          body: JSON.stringify({
            variables: spec.variables,
            features: spec.features,
            queryId: spec.queryId,
          }),
        };

  hooks.onAdmitted?.();

  let response: Response;
  try {
    response = await transport.fetchWithTimeout(url, init);
  } catch (error) {
    return {
      kind: 'error',
      error: error instanceof Error ? error.message : String(error),
      errorKind: 'network_error',
      source: 'transport',
    };
  }

  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    if (response.status !== 429) {
      return {
        kind: 'error',
        error: error instanceof Error ? error.message : String(error),
        errorKind: 'network_error',
        source: 'transport',
      };
    }
    const headers = pickCaptureHeaders(response.headers as Headers | Record<string, string> | undefined);
    return {
      kind: 'paused',
      retryAt: retryAtIso(parseRetryAt(headers) ?? conservativeRetryAt()),
      error: 'HTTP 429',
      errorKind: 'rate_limited',
    };
  }

  const captured: CapturedResponse = {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    requestId: spec.requestId,
    attemptId: randomUUID(),
    operation: spec.operation,
    queryId: spec.queryId,
    method: spec.method,
    variables: spec.variables,
    fetchedAt: new Date().toISOString(),
    status: response.status,
    headers: pickCaptureHeaders(response.headers as Headers | Record<string, string> | undefined),
    body,
  };

  if (hooks.onResponse) {
    try {
      await hooks.onResponse(captured);
    } catch (error) {
      return {
        kind: 'error',
        error: error instanceof Error ? error.message : String(error),
        errorKind: 'persistence_failed',
        captured,
        source: 'persist',
      };
    }
  }

  return {
    kind: 'http',
    captured,
    envelope: parseEnvelope(body),
  };
}

export async function captureGraphqlPage(options: {
  transport: GraphqlPageTransport;
  operation: CaptureOperation;
  requestId: string;
  getQueryIds: () => Promise<string[]>;
  buildVariables: () => Record<string, unknown>;
  buildFeatures: () => Record<string, boolean>;
  fieldToggles?: () => Record<string, boolean>;
  allowPostFallback: boolean;
  featureSetName: string;
  beforeAttempt?: BeforeAttemptGate;
  onResponse?: OnResponse;
}): Promise<PageResult> {
  const variables = options.buildVariables();
  let lastCaptured: CapturedResponse | undefined;
  let lastEnvelope: unknown;
  let lastError: string | undefined;
  let lastErrorKind: string | undefined;
  let had404 = false;
  let sawUnspecifiedQuery = false;
  const addedFlags = new Set<string>();
  let heals = 0;
  let attemptIndex = 0;
  let attemptCount = 0;

  const withCount = (result: Omit<PageResult, 'attemptCount'>): PageResult => ({
    ...result,
    attemptCount,
  });

  const runAttempt = async (queryId: string, method: CaptureHttpMethod): Promise<AttemptResult> => {
    attemptIndex += 1;
    return executeGraphqlAttempt(
      options.transport,
      {
        operation: options.operation,
        queryId,
        method,
        variables,
        features: options.buildFeatures(),
        fieldToggles: options.fieldToggles?.(),
        requestId: options.requestId,
        attemptIndex,
      },
      {
        beforeAttempt: options.beforeAttempt,
        onResponse: options.onResponse,
        onAdmitted: () => {
          attemptCount += 1;
        },
      },
    );
  };

  const toPaused = (result: AttemptPausedResult): PageResult =>
    withCount({
      outcome: 'paused',
      retryAt: result.retryAt,
      response: result.captured ?? lastCaptured,
      envelope: lastEnvelope,
      error: result.error,
      errorKind: result.errorKind,
    });

  const toError = (result: AttemptErrorResult): PageResult =>
    withCount({
      outcome: 'error',
      response: result.captured ?? lastCaptured,
      envelope: lastEnvelope,
      error: result.error,
      errorKind: result.errorKind,
    });

  const finalizeHttp = (result: AttemptHttpResult): PageResult | { continue: true; retryAfterHeal: boolean } => {
    lastCaptured = result.captured;
    lastEnvelope = result.envelope;

    if (result.captured.status === 429) {
      const retryAt = retryAtIso(parseRetryAt(result.captured.headers) ?? conservativeRetryAt());
      return withCount({
        outcome: 'paused',
        retryAt,
        response: result.captured,
        envelope: result.envelope,
        error: `HTTP 429`,
        errorKind: 'rate_limited',
      });
    }

    if (result.captured.status === 200) {
      const usable = hasUsablePageData(options.operation, result.envelope);
      if (usable) {
        return withCount({
          outcome: 'ok',
          response: result.captured,
          envelope: result.envelope,
        });
      }

      const healSource = featureHealSource(result.captured, result.envelope);
      const missing = parseMissingFeatureFlags(healSource);
      if (missing && heals < 2) {
        const newFlags = missing.filter((flag) => !addedFlags.has(flag));
        if (newFlags.length > 0) {
          return { continue: true, retryAfterHeal: true };
        }
      }

      const graphqlMessage = graphqlErrorMessage(result.envelope);
      if (graphqlMessage?.includes('Query: Unspecified')) {
        sawUnspecifiedQuery = true;
        lastError = graphqlMessage;
        lastErrorKind = 'graphql_error';
        return { continue: true, retryAfterHeal: false };
      }

      if (result.envelope === undefined) {
        lastError = 'Malformed JSON response';
        lastErrorKind = 'parse_error';
        return withCount({
          outcome: 'error',
          response: result.captured,
          envelope: result.envelope,
          error: lastError,
          errorKind: 'parse_error',
        });
      }

      if (graphqlMessage) {
        lastError = graphqlMessage;
        lastErrorKind = 'graphql_error';
        return withCount({
          outcome: 'error',
          response: result.captured,
          envelope: result.envelope,
          error: lastError,
          errorKind: 'graphql_error',
        });
      }

      return withCount({
        outcome: 'ok',
        response: result.captured,
        envelope: result.envelope,
      });
    }

    if (result.captured.status === 404) {
      had404 = true;
      lastError = 'HTTP 404';
      lastErrorKind = 'http_error';
      return { continue: true, retryAfterHeal: false };
    }

    const healSource = featureHealSource(result.captured, result.envelope);
    const missing = parseMissingFeatureFlags(healSource);
    if (missing && heals < 2) {
      const newFlags = missing.filter((flag) => !addedFlags.has(flag));
      if (newFlags.length > 0) {
        return { continue: true, retryAfterHeal: true };
      }
    }

    const graphqlMessage = graphqlErrorMessage(result.envelope);
    if (graphqlMessage?.includes('Query: Unspecified')) {
      sawUnspecifiedQuery = true;
      lastError = graphqlMessage;
      lastErrorKind = 'graphql_error';
      return { continue: true, retryAfterHeal: false };
    }

    lastError = result.captured.status
      ? `HTTP ${result.captured.status}: ${truncateErrorBody(result.captured.body)}`
      : (graphqlMessage ?? 'Unknown error');
    lastErrorKind = 'http_error';
    return withCount({
      outcome: 'error',
      response: result.captured,
      envelope: result.envelope,
      error: lastError,
      errorKind: lastErrorKind,
    });
  };

  const applyHeal = async (healSource: string): Promise<boolean> => {
    const missing = parseMissingFeatureFlags(healSource);
    if (!missing) {
      return false;
    }
    const newFlags = missing.filter((flag) => !addedFlags.has(flag));
    if (newFlags.length === 0) {
      return false;
    }
    const overrides: Record<string, boolean> = {};
    for (const flag of newFlags) {
      overrides[flag] = true;
      addedFlags.add(flag);
    }
    try {
      await addFeatureOverrides(options.featureSetName, overrides);
    } catch {
      return false;
    }
    heals += 1;
    return true;
  };

  const tryQueryIds = async (queryIds: string[]): Promise<PageResult | undefined> => {
    for (const queryId of queryIds) {
      const getResult = await runAttempt(queryId, 'GET');
      if (getResult.kind === 'paused') {
        return toPaused(getResult);
      }
      if (getResult.kind === 'error') {
        if (getResult.source === 'gate' || getResult.source === 'persist') {
          return toError(getResult);
        }
        if (getResult.errorKind === 'persistence_failed' || getResult.errorKind === 'gate_error') {
          return toError(getResult);
        }
        if (
          options.operation === 'Likes' &&
          getResult.source === 'transport' &&
          getResult.errorKind === 'network_error'
        ) {
          lastError = getResult.error;
          lastErrorKind = getResult.errorKind;
          continue;
        }
        return toError(getResult);
      }

      const classified = finalizeHttp(getResult);
      if (!('continue' in classified)) {
        if (
          classified.outcome === 'error' &&
          classified.errorKind === 'http_error' &&
          (had404 || sawUnspecifiedQuery)
        ) {
          lastError = classified.error;
          lastErrorKind = classified.errorKind;
          continue;
        }
        return classified;
      }

      if (classified.retryAfterHeal) {
        const healed = await applyHeal(featureHealSource(getResult.captured, getResult.envelope));
        if (healed) {
          const healedResult = await tryQueryIds(queryIds);
          if (healedResult) {
            return healedResult;
          }
        } else {
          return withCount({
            outcome: 'error',
            response: getResult.captured,
            envelope: getResult.envelope,
            error: `HTTP ${getResult.captured.status}: ${truncateErrorBody(getResult.captured.body)}`,
            errorKind: 'http_error',
          });
        }
        continue;
      }

      if (getResult.captured.status === 404 && options.allowPostFallback) {
        const postResult = await runAttempt(queryId, 'POST');
        if (postResult.kind === 'paused') {
          return toPaused(postResult);
        }
        if (postResult.kind === 'error') {
          return toError(postResult);
        }
        const postClassified = finalizeHttp(postResult);
        if (!('continue' in postClassified)) {
          if (
            postClassified.outcome === 'error' &&
            postClassified.errorKind === 'http_error' &&
            (had404 || sawUnspecifiedQuery)
          ) {
            lastError = postClassified.error;
            lastErrorKind = postClassified.errorKind;
            return undefined;
          }
          return postClassified;
        }
        if (postClassified.retryAfterHeal) {
          const healed = await applyHeal(featureHealSource(postResult.captured, postResult.envelope));
          if (healed) {
            const healedResult = await tryQueryIds(queryIds);
            if (healedResult) {
              return healedResult;
            }
          }
        }
      }
    }

    return undefined;
  };

  const firstPassIds = await options.getQueryIds();
  const firstPass = await tryQueryIds(firstPassIds);
  if (firstPass) {
    return firstPass;
  }

  if (had404 || sawUnspecifiedQuery) {
    await options.transport.refreshQueryIds();
    const refreshedIds = await options.getQueryIds();
    const secondPass = await tryQueryIds(refreshedIds);
    if (secondPass) {
      return secondPass;
    }
  }

  return withCount({
    outcome: 'error',
    response: lastCaptured,
    envelope: lastEnvelope,
    error: lastError ?? 'Unknown error fetching page',
    errorKind: lastErrorKind ?? 'http_error',
  });
}
