import { randomBytes, randomUUID } from 'node:crypto';
import { addFeatureOverrides } from './runtime-features.js';
import { runtimeQueryIds } from './runtime-query-ids.js';
import { type OperationName, QUERY_IDS, TARGET_QUERY_ID_OPERATIONS } from './twitter-client-constants.js';
import type { CurrentUserResult, TwitterClientOptions } from './twitter-client-types.js';
import { normalizeQuoteDepth } from './twitter-client-utils.js';

const MISSING_FEATURES_REGEX = /features cannot be null:\s*([a-z0-9_,\s]+)/i;
const FEATURE_FLAG_NAME_REGEX = /^[a-z][a-z0-9_]*$/i;

/** Marker appended by truncateErrorBody when a response body was cut off. */
export const ERROR_BODY_TRUNCATION_MARKER = '…';
const ERROR_BODY_MAX_CHARS = 400;

/**
 * Truncate an error-response body for inclusion in an error string, appending a
 * marker so downstream parsers (parseMissingFeatureFlags) can tell that the
 * final token may have been cut mid-name.
 */
export function truncateErrorBody(text: string): string {
  if (text.length <= ERROR_BODY_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, ERROR_BODY_MAX_CHARS)}${ERROR_BODY_TRUNCATION_MARKER}`;
}

/** Parse missing feature flag names from an X GraphQL 336-style error message. */
export function parseMissingFeatureFlags(error: string): string[] | null {
  const match = MISSING_FEATURES_REGEX.exec(error);
  if (!match?.[1]) {
    return null;
  }
  const names = match[1]
    .split(',')
    .map((name) => name.trim())
    .filter((name) => FEATURE_FLAG_NAME_REGEX.test(name));
  // If the flag list runs right up against the truncation marker, the final
  // token may be a mid-name fragment of a real flag — drop it rather than
  // persisting a corrupted name.
  const captureEnd = match.index + match[0].length;
  if (error[captureEnd] === ERROR_BODY_TRUNCATION_MARKER && names.length > 0) {
    names.pop();
  }
  return names.length > 0 ? names : null;
}

// biome-ignore lint/suspicious/noExplicitAny: TS mixin base constructor requirement.
export type Constructor<T = object> = new (...args: any[]) => T;
// biome-ignore lint/suspicious/noExplicitAny: TS mixin base constructor requirement.
export type AbstractConstructor<T = object> = abstract new (...args: any[]) => T;
export type Mixin<TBase extends AbstractConstructor<TwitterClientBase>, TAdded> = abstract new (
  ...args: ConstructorParameters<TBase>
) => TwitterClientBase & TAdded;

export abstract class TwitterClientBase {
  protected authToken: string;
  protected ct0: string;
  protected cookieHeader: string;
  protected userAgent: string;
  protected timeoutMs?: number;
  protected quoteDepth: number;
  protected clientUuid: string;
  protected clientDeviceId: string;
  protected clientUserId?: string;

  constructor(options: TwitterClientOptions) {
    if (!options.cookies.authToken || !options.cookies.ct0) {
      throw new Error('Both authToken and ct0 cookies are required');
    }
    this.authToken = options.cookies.authToken;
    this.ct0 = options.cookies.ct0;
    this.cookieHeader = options.cookies.cookieHeader || `auth_token=${this.authToken}; ct0=${this.ct0}`;
    this.userAgent =
      options.userAgent ||
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    this.timeoutMs = options.timeoutMs;
    this.quoteDepth = normalizeQuoteDepth(options.quoteDepth);
    this.clientUuid = randomUUID();
    this.clientDeviceId = randomUUID();
  }

  protected abstract getCurrentUser(): Promise<CurrentUserResult>;

  protected async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  protected async getQueryId(operationName: OperationName): Promise<string> {
    const cached = await runtimeQueryIds.getQueryId(operationName);
    return cached ?? QUERY_IDS[operationName];
  }

  protected async refreshQueryIds(): Promise<void> {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    try {
      await runtimeQueryIds.refresh(TARGET_QUERY_ID_OPERATIONS, { force: true });
    } catch {
      // ignore refresh failures; callers will fall back to baked-in IDs
    }
  }

  protected async withRefreshedQueryIdsOn404<T extends { success: boolean; had404?: boolean }>(
    attempt: () => Promise<T>,
  ): Promise<{ result: T; refreshed: boolean }> {
    const firstAttempt = await attempt();
    if (firstAttempt.success || !firstAttempt.had404) {
      return { result: firstAttempt, refreshed: false };
    }
    await this.refreshQueryIds();
    const secondAttempt = await attempt();
    return { result: secondAttempt, refreshed: true };
  }

  /**
   * Self-heal X GraphQL error 336 ("features cannot be null"): when the API
   * requires feature flags the client omitted, persist them via
   * `addFeatureOverrides` and retry (max 2 heal retries).
   *
   * The attempt closure MUST rebuild its `features` object on each call
   * (e.g. via `applyFeatureOverrides` / `build*Features`) so healed overrides
   * take effect.
   */
  protected async withFeatureHeal<T extends { success: boolean; error?: string }>(
    setName: string,
    attempt: () => Promise<T>,
  ): Promise<T> {
    const addedFlags = new Set<string>();
    let result = await attempt();
    let heals = 0;

    while (!result.success && heals < 2) {
      const missing = parseMissingFeatureFlags(result.error ?? '');
      if (!missing) {
        break;
      }

      const newFlags = missing.filter((flag) => !addedFlags.has(flag));
      if (newFlags.length === 0) {
        break;
      }

      const overrides: Record<string, boolean> = {};
      for (const flag of newFlags) {
        overrides[flag] = true;
        addedFlags.add(flag);
      }

      try {
        await addFeatureOverrides(setName, overrides);
      } catch {
        break;
      }

      heals += 1;
      result = await attempt();
    }

    return result;
  }

  protected async getTweetDetailQueryIds(): Promise<string[]> {
    const primary = await this.getQueryId('TweetDetail');
    return Array.from(new Set([primary, '97JF30KziU00483E_8elBA', 'aFvUsJm2c-oDkJV75blV6g']));
  }

  protected async getSearchTimelineQueryIds(): Promise<string[]> {
    const primary = await this.getQueryId('SearchTimeline');
    return Array.from(new Set([primary, 'M1jEez78PEfVfbQLvlWMvQ', '5h0kNbk3ii97rmfY6CdgAA', 'Tp1sewRU1AsZpBWhqCZicQ']));
  }

  protected async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    if (!this.timeoutMs || this.timeoutMs <= 0) {
      return fetch(url, init);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  protected getHeaders(): Record<string, string> {
    return this.getJsonHeaders();
  }

  protected createTransactionId(): string {
    return randomBytes(16).toString('hex');
  }

  protected getBaseHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      accept: '*/*',
      'accept-language': 'en-US,en;q=0.9',
      authorization:
        'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
      'x-csrf-token': this.ct0,
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'en',
      'x-client-uuid': this.clientUuid,
      'x-twitter-client-deviceid': this.clientDeviceId,
      'x-client-transaction-id': this.createTransactionId(),
      cookie: this.cookieHeader,
      'user-agent': this.userAgent,
      origin: 'https://x.com',
      referer: 'https://x.com/',
    };

    if (this.clientUserId) {
      headers['x-twitter-client-user-id'] = this.clientUserId;
    }

    return headers;
  }

  protected getJsonHeaders(): Record<string, string> {
    return {
      ...this.getBaseHeaders(),
      'content-type': 'application/json',
    };
  }

  protected getUploadHeaders(): Record<string, string> {
    // Note: do not set content-type; URLSearchParams/FormData need to set it (incl boundary) themselves.
    return this.getBaseHeaders();
  }

  protected async ensureClientUserId(): Promise<void> {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    if (this.clientUserId) {
      return;
    }
    const result = await this.getCurrentUser();
    if (result.success && result.user?.id) {
      this.clientUserId = result.user.id;
    }
  }
}
