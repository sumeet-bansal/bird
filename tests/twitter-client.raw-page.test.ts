import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureAttemptGate } from '../src/lib/capture-gate.js';
import { clearFeatureOverridesCache } from '../src/lib/runtime-features.js';
import { TwitterClient } from '../src/lib/twitter-client.js';
import type { CapturedResponse } from '../src/lib/twitter-client-page-request.js';
import {
  CONSERVATIVE_RETRY_DELAY_MS,
  parseRetryAt,
  pickCaptureHeaders,
} from '../src/lib/twitter-client-page-request.js';
import { type TwitterClientPrivate, validCookies } from './twitter-client-fixtures.js';

const originalFetch = global.fetch;

function mockResponse(options: { status: number; body: string; headers?: Record<string, string> }): {
  ok: boolean;
  status: number;
  headers: Headers;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
} {
  const headers = new Headers(options.headers);
  return {
    ok: options.status >= 200 && options.status < 300,
    status: options.status,
    headers,
    text: async () => options.body,
    json: async () => JSON.parse(options.body) as unknown,
  };
}

const likesEnvelope = {
  data: {
    user: {
      result: {
        timeline: {
          timeline: {
            instructions: [
              {
                type: 'TimelineAddEntries',
                entries: [
                  {
                    content: {
                      itemContent: {
                        tweet_results: {
                          result: {
                            rest_id: '2',
                            legacy: { full_text: 'liked' },
                            core: {
                              user_results: {
                                result: { legacy: { screen_name: 'root', name: 'Root' } },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                  {
                    content: {
                      itemType: 'TimelineTimelineCursor',
                      cursorType: 'Bottom',
                      value: 'cursor-next',
                    },
                  },
                  {
                    content: {
                      itemType: 'TimelineUnknownWrapper',
                      mystery: true,
                    },
                  },
                ],
              },
              {
                type: 'TimelineAddToModule',
                moduleItems: [{ item: { itemContent: { value: 'show-more-item' } } }],
              },
              {
                type: 'TimelineTerminateTimeline',
                direction: 'Top',
              },
              {
                type: 'TimelineShowMore',
                cursor: { value: 'show-more', cursorType: 'ShowMore' },
              },
            ],
          },
        },
      },
    },
  },
};

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  delete process.env.BIRD_FEATURES_PATH;
  clearFeatureOverridesCache();
});

describe('TwitterClient raw page capture', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
    const cacheDir = path.join(os.tmpdir(), `bird-raw-page-${randomUUID()}`);
    await mkdir(cacheDir, { recursive: true });
    process.env.BIRD_FEATURES_PATH = path.join(cacheDir, 'features.json');
    clearFeatureOverridesCache();
  });

  function clientWithLikesIds(ids: string[] = ['test']): TwitterClient & TwitterClientPrivate {
    const client = new TwitterClient({ cookies: validCookies }) as TwitterClient & TwitterClientPrivate;
    client.getLikesQueryIds = async () => ids;
    client.getCurrentUser = async () => ({
      success: true,
      user: { id: '42', username: 'tester', name: 'Tester' },
    });
    return client;
  }

  it('persists the exact body string before parse and keeps unknown envelope items', async () => {
    const exactBody = `${JSON.stringify(likesEnvelope)}`;
    const persistOrder: string[] = [];
    let persisted: CapturedResponse | undefined;
    mockFetch.mockResolvedValueOnce(mockResponse({ status: 200, body: exactBody }));

    const result = await clientWithLikesIds().captureLikesPage({
      requestId: 'req-1',
      userId: '42',
      count: 20,
      onResponse: async (response) => {
        persistOrder.push('persist');
        persisted = response;
        expect(response.body).toBe(exactBody);
      },
    });

    persistOrder.push('return');
    expect(persistOrder).toEqual(['persist', 'return']);
    expect(result.outcome).toBe('ok');
    expect(result.response?.body).toBe(exactBody);
    expect(result.envelope).toEqual(likesEnvelope);
    const instructions = (
      result.envelope as {
        data: { user: { result: { timeline: { timeline: { instructions: Array<{ type: string }> } } } } };
      }
    ).data.user.result.timeline.timeline.instructions;
    expect(instructions.map((item) => item.type)).toEqual([
      'TimelineAddEntries',
      'TimelineAddToModule',
      'TimelineTerminateTimeline',
      'TimelineShowMore',
    ]);
    expect(persisted?.headers.authorization).toBeUndefined();
    expect(persisted?.headers.cookie).toBeUndefined();
    expect(JSON.stringify(persisted)).not.toContain(validCookies.authToken);
    expect(JSON.stringify(persisted)).not.toContain(validCookies.ct0);
  });

  it('captures malformed JSON and non-200 bodies without retrying', async () => {
    const malformed = '{not-json';
    mockFetch.mockResolvedValueOnce(mockResponse({ status: 200, body: malformed }));
    const first = await clientWithLikesIds().captureLikesPage({
      requestId: 'req-malformed',
      userId: '42',
    });
    expect(first.outcome).toBe('error');
    expect(first.errorKind).toBe('parse_error');
    expect(first.response?.body).toBe(malformed);
    expect(first.envelope).toBeUndefined();

    mockFetch.mockResolvedValueOnce(mockResponse({ status: 403, body: 'restricted' }));
    const second = await clientWithLikesIds().captureLikesPage({
      requestId: 'req-403',
      userId: '42',
    });
    expect(second.outcome).toBe('error');
    expect(second.errorKind).toBe('http_error');
    expect(second.response?.status).toBe(403);
    expect(second.response?.body).toBe('restricted');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('stops every retry when onResponse persistence fails', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse({ status: 404, body: 'missing' }))
      .mockResolvedValueOnce(mockResponse({ status: 200, body: JSON.stringify(likesEnvelope) }));

    const result = await clientWithLikesIds(['first', 'second']).captureLikesPage({
      requestId: 'req-persist',
      userId: '42',
      onResponse: async () => {
        throw new Error('disk full');
      },
    });

    expect(result.outcome).toBe('error');
    expect(result.errorKind).toBe('persistence_failed');
    expect(result.error).toBe('disk full');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not feature-heal after a persistence failure on errors-only HTTP 200', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        status: 200,
        body: JSON.stringify({ errors: [{ message: 'The following features cannot be null: foo_enabled' }] }),
      }),
    );
    const result = await clientWithLikesIds().captureLikesPage({
      requestId: 'req-persist-heal',
      userId: '42',
      onResponse: async () => {
        throw new Error('disk full');
      },
    });
    expect(result.outcome).toBe('error');
    expect(result.errorKind).toBe('persistence_failed');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not transport when beforeAttempt denies the first attempt', async () => {
    const result = await clientWithLikesIds().captureLikesPage({
      requestId: 'req-deny-first',
      userId: '42',
      beforeAttempt: async () => ({
        action: 'pause',
        retryAt: '2026-09-08T20:00:00.000Z',
        errorKind: 'not_before',
      }),
    });

    expect(result.outcome).toBe('paused');
    expect(result.retryAt).toBe('2026-09-08T20:00:00.000Z');
    expect(result.errorKind).toBe('not_before');
    expect(result.attemptCount).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not transport a feature repair when beforeAttempt denies it', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        status: 400,
        body: 'The following features cannot be null: foo_enabled',
      }),
    );

    let gated = 0;
    const result = await clientWithLikesIds().captureLikesPage({
      requestId: 'req-deny-repair',
      userId: '42',
      beforeAttempt: async () => {
        gated += 1;
        if (gated === 1) {
          return { action: 'proceed' };
        }
        return { action: 'error', error: 'no repair', errorKind: 'budget_exhausted' };
      },
    });

    expect(gated).toBe(2);
    expect(result.outcome).toBe('error');
    expect(result.errorKind).toBe('budget_exhausted');
    expect(result.attemptCount).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('pauses on 429 using Retry-After delta seconds', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        status: 429,
        body: 'slow down',
        headers: { 'retry-after': '12', 'x-rate-limit-remaining': '0' },
      }),
    );
    const before = Date.now();
    const result = await clientWithLikesIds().captureLikesPage({
      requestId: 'req-429-delta',
      userId: '42',
    });
    expect(result.outcome).toBe('paused');
    expect(result.errorKind).toBe('rate_limited');
    expect(result.response?.body).toBe('slow down');
    expect(result.retryAt).toBeDefined();
    const retryMs = Date.parse(result.retryAt ?? '');
    expect(retryMs).toBeGreaterThanOrEqual(before + 12_000 - 50);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('pauses on 429 using Retry-After HTTP-date or reset epoch', async () => {
    const httpDate = 'Wed, 09 Sep 2026 01:00:00 GMT';
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        status: 429,
        body: 'later',
        headers: { 'retry-after': httpDate },
      }),
    );
    const dated = await clientWithLikesIds().captureLikesPage({
      requestId: 'req-429-date',
      userId: '42',
    });
    expect(dated.outcome).toBe('paused');
    expect(dated.retryAt).toBe(new Date(httpDate).toISOString());

    mockFetch.mockResolvedValueOnce(
      mockResponse({
        status: 429,
        body: 'reset',
        headers: { 'x-rate-limit-reset': '1890000000' },
      }),
    );
    const reset = await clientWithLikesIds().captureLikesPage({
      requestId: 'req-429-reset',
      userId: '42',
    });
    expect(reset.retryAt).toBe(new Date(1_890_000_000 * 1000).toISOString());

    mockFetch.mockResolvedValueOnce(mockResponse({ status: 429, body: 'no headers' }));
    const conservative = await clientWithLikesIds().captureLikesPage({
      requestId: 'req-429-none',
      userId: '42',
    });
    expect(conservative.outcome).toBe('paused');
    expect(Date.parse(conservative.retryAt ?? '')).toBeGreaterThan(Date.now());
  });

  it('captures every query-id fallback and a successful likes page', async () => {
    const captured: CapturedResponse[] = [];
    mockFetch
      .mockResolvedValueOnce(mockResponse({ status: 404, body: 'gone-1' }))
      .mockResolvedValueOnce(mockResponse({ status: 200, body: JSON.stringify(likesEnvelope) }));

    const result = await clientWithLikesIds(['qid-a', 'qid-b']).captureLikesPage({
      requestId: 'req-fallback',
      userId: '42',
      onResponse: async (response) => {
        captured.push(response);
      },
    });

    expect(result.outcome).toBe('ok');
    expect(captured).toHaveLength(2);
    expect(captured[0]?.status).toBe(404);
    expect(captured[0]?.queryId).toBe('qid-a');
    expect(captured[1]?.queryId).toBe('qid-b');
    expect(captured[1]?.body).toBe(JSON.stringify(likesEnvelope));
  });

  it('captures TweetDetail GET 404, POST fallback, and feature repair', async () => {
    const captured: CapturedResponse[] = [];
    mockFetch
      .mockResolvedValueOnce(mockResponse({ status: 404, body: 'no-get' }))
      .mockResolvedValueOnce(
        mockResponse({
          status: 400,
          body: 'The following features cannot be null: detail_flag_enabled',
        }),
      )
      .mockResolvedValueOnce(
        mockResponse({
          status: 200,
          body: JSON.stringify({
            data: { tweetResult: { result: { rest_id: '9' } } },
            errors: [{ message: 'is_translatable' }],
          }),
        }),
      );

    const client = new TwitterClient({ cookies: validCookies });
    const clientPrivate = client as unknown as TwitterClient & { getTweetDetailQueryIds: () => Promise<string[]> };
    clientPrivate.getTweetDetailQueryIds = async () => ['td-1'];

    const result = await client.captureTweetDetailPage({
      requestId: 'req-detail',
      tweetId: '9',
      cursor: 'show-more',
      onResponse: async (response) => {
        captured.push(response);
      },
    });

    expect(result.outcome).toBe('ok');
    expect(captured).toHaveLength(3);
    expect(captured.map((item) => item.method)).toEqual(['GET', 'POST', 'GET']);
    expect(result.envelope).toEqual({
      data: { tweetResult: { result: { rest_id: '9' } } },
      errors: [{ message: 'is_translatable' }],
    });
    const thirdUrl = String(mockFetch.mock.calls[2]?.[0]);
    const features = JSON.parse(new URL(thirdUrl).searchParams.get('features') as string) as Record<string, boolean>;
    expect(features.detail_flag_enabled).toBe(true);
  });

  it('repairs errors-only HTTP 200 feature failures and leaves partial-usable 200 alone', async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockResponse({
          status: 200,
          body: JSON.stringify({ errors: [{ message: 'The following features cannot be null: foo_enabled' }] }),
        }),
      )
      .mockResolvedValueOnce(mockResponse({ status: 200, body: JSON.stringify(likesEnvelope) }));

    const repaired = await clientWithLikesIds().captureLikesPage({
      requestId: 'req-200-heal',
      userId: '42',
    });
    expect(repaired.outcome).toBe('ok');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const repairedFeatures = JSON.parse(
      new URL(mockFetch.mock.calls[1]?.[0] as string).searchParams.get('features') as string,
    ) as Record<string, boolean>;
    expect(repairedFeatures.foo_enabled).toBe(true);

    mockFetch.mockClear();
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        status: 200,
        body: JSON.stringify({
          data: likesEnvelope.data,
          errors: [{ message: 'The following features cannot be null: bar_enabled' }],
        }),
      }),
    );
    const partial = await clientWithLikesIds().captureLikesPage({
      requestId: 'req-200-partial',
      userId: '42',
    });
    expect(partial.outcome).toBe('ok');
    expect(partial.envelope).toEqual({
      data: likesEnvelope.data,
      errors: [{ message: 'The following features cannot be null: bar_enabled' }],
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('maps shared likes/detail pages through normalized callers', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse({ status: 404, body: 'gone' }))
      .mockResolvedValueOnce(mockResponse({ status: 200, body: JSON.stringify(likesEnvelope) }));
    const likes = await clientWithLikesIds(['qid-a', 'qid-b']).getLikes(1);
    expect(likes.success).toBe(true);
    expect(likes.tweets?.[0]?.id).toBe('2');
    expect(mockFetch).toHaveBeenCalledTimes(2);

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        status: 200,
        body: JSON.stringify({
          data: {
            tweetResult: {
              result: {
                rest_id: '1',
                legacy: {
                  full_text: 'hi',
                  created_at: '2024-01-01T00:00:00Z',
                  reply_count: 0,
                  retweet_count: 0,
                  favorite_count: 0,
                },
                core: { user_results: { result: { legacy: { screen_name: 'root', name: 'Root' } } } },
              },
            },
          },
          errors: [{ message: 'is_translatable' }],
        }),
      }),
    );
    const client = new TwitterClient({ cookies: validCookies });
    const tweet = await client.getTweet('1');
    expect(tweet.success).toBe(true);
    expect(tweet.tweet?.id).toBe('1');
  });

  it('keeps HTTP 200 GraphQL errors intact as request success', async () => {
    const body = JSON.stringify({
      data: { tweetResult: { result: { rest_id: '1' } } },
      errors: [{ message: 'partial' }],
    });
    mockFetch.mockResolvedValueOnce(mockResponse({ status: 200, body }));
    const client = new TwitterClient({ cookies: validCookies });
    const result = await client.captureTweetDetailPage({
      requestId: 'req-partial',
      tweetId: '1',
    });
    expect(result.outcome).toBe('ok');
    expect(result.envelope).toEqual({
      data: { tweetResult: { result: { rest_id: '1' } } },
      errors: [{ message: 'partial' }],
    });
  });

  it('does not treat optional user lookup as a selected-endpoint attempt', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ status: 200, body: JSON.stringify(likesEnvelope) }));
    let gated = 0;
    const client = clientWithLikesIds();
    const result = await client.captureLikesPage({
      requestId: 'req-lookup',
      beforeAttempt: async () => {
        gated += 1;
        return { action: 'proceed' };
      },
    });
    expect(result.outcome).toBe('ok');
    expect(gated).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns user_lookup_failed without transport when identity discovery fails', async () => {
    const client = clientWithLikesIds();
    client.getCurrentUser = async () => ({ success: false, error: 'no user' });
    const result = await client.captureLikesPage({ requestId: 'req-nouser' });
    expect(result.outcome).toBe('error');
    expect(result.errorKind).toBe('user_lookup_failed');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects invalid likes count and missing request id', async () => {
    const client = clientWithLikesIds();
    expect(await client.captureLikesPage({ requestId: '', userId: '1' })).toMatchObject({
      outcome: 'error',
      errorKind: 'invalid_request',
      attemptCount: 0,
    });
    expect(await client.captureLikesPage({ requestId: 'x', userId: '1', count: 21 })).toMatchObject({
      outcome: 'error',
      errorKind: 'invalid_request',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('passes the opaque cursor through likes and detail variables', async () => {
    mockFetch.mockResolvedValue(mockResponse({ status: 200, body: '{}' }));
    await clientWithLikesIds().captureLikesPage({
      requestId: 'req-cursor',
      userId: '42',
      cursor: 'opaque-likes',
    });
    const likesVars = JSON.parse(
      new URL(mockFetch.mock.calls[0]?.[0] as string).searchParams.get('variables') as string,
    );
    expect(likesVars.cursor).toBe('opaque-likes');

    const client = new TwitterClient({ cookies: validCookies });
    await client.captureTweetDetailPage({
      requestId: 'req-cursor-d',
      tweetId: '1',
      cursor: 'opaque-detail',
    });
    const detailVars = JSON.parse(
      new URL(mockFetch.mock.calls[1]?.[0] as string).searchParams.get('variables') as string,
    );
    expect(detailVars.cursor).toBe('opaque-detail');
    expect(detailVars.focalTweetId).toBe('1');
  });

  it('surfaces a thrown beforeAttempt as a gate error without fetching', async () => {
    const result = await clientWithLikesIds().captureLikesPage({
      requestId: 'req-throw',
      userId: '42',
      beforeAttempt: async () => {
        throw new Error('gate crashed');
      },
    });
    expect(result.outcome).toBe('error');
    expect(result.errorKind).toBe('gate_error');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('tries the next query id after Query: Unspecified and captures both responses', async () => {
    const captured: CapturedResponse[] = [];
    mockFetch
      .mockResolvedValueOnce(
        mockResponse({
          status: 400,
          body: JSON.stringify({ errors: [{ message: 'Query: Unspecified' }] }),
        }),
      )
      .mockResolvedValueOnce(mockResponse({ status: 200, body: JSON.stringify(likesEnvelope) }));

    const result = await clientWithLikesIds(['qid-a', 'qid-b']).captureLikesPage({
      requestId: 'req-unspecified',
      userId: '42',
      onResponse: async (response) => {
        captured.push(response);
      },
    });

    expect(result.outcome).toBe('ok');
    expect(captured).toHaveLength(2);
    expect(captured[0]?.queryId).toBe('qid-a');
    expect(captured[1]?.queryId).toBe('qid-b');
  });

  it('rejects a TweetDetail capture without a tweet id', async () => {
    const client = new TwitterClient({ cookies: validCookies });
    const result = await client.captureTweetDetailPage({ requestId: 'req-empty', tweetId: '' });
    expect(result.outcome).toBe('error');
    expect(result.errorKind).toBe('invalid_request');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('surfaces network failures after the gate proceeds', async () => {
    mockFetch.mockRejectedValueOnce(new Error('socket down'));
    const result = await clientWithLikesIds().captureLikesPage({
      requestId: 'req-net',
      userId: '42',
    });
    expect(result.outcome).toBe('error');
    expect(result.errorKind).toBe('network_error');
    expect(result.error).toBe('socket down');
    expect(result.attemptCount).toBe(1);
    expect(result.response).toBeUndefined();
  });

  it('reports unrecoverable errors-only HTTP 200 as graphql_error after repairs', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        status: 200,
        body: JSON.stringify({ errors: [{ message: 'Rate limited by query' }] }),
      }),
    );
    const result = await clientWithLikesIds().captureLikesPage({
      requestId: 'req-gql-only',
      userId: '42',
    });
    expect(result.outcome).toBe('error');
    expect(result.errorKind).toBe('graphql_error');
    expect(result.error).toContain('Rate limited by query');
    expect(result.response?.body).toContain('Rate limited by query');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps a valid unknown envelope with no GraphQL errors as ok', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ status: 200, body: '{}' }));
    const result = await clientWithLikesIds().captureLikesPage({
      requestId: 'req-unknown',
      userId: '42',
    });
    expect(result.outcome).toBe('ok');
    expect(result.envelope).toEqual({});
    expect(result.response?.body).toBe('{}');
  });

  it('tries the next likes query id after a transport failure and still gates each attempt', async () => {
    const gated: string[] = [];
    mockFetch
      .mockRejectedValueOnce(new Error('socket down'))
      .mockResolvedValueOnce(mockResponse({ status: 200, body: JSON.stringify(likesEnvelope) }));
    const result = await clientWithLikesIds(['qid-a', 'qid-b']).captureLikesPage({
      requestId: 'req-likes-net-fallback',
      userId: '42',
      beforeAttempt: async (info) => {
        gated.push(info.queryId);
        return { action: 'proceed' };
      },
    });
    expect(result.outcome).toBe('ok');
    expect(gated).toEqual(['qid-a', 'qid-b']);
    expect(result.attemptCount).toBe(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(String(mockFetch.mock.calls[1]?.[0])).toContain('/qid-b/');
  });

  it('does not try the next TweetDetail query id after a transport failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('socket down')).mockResolvedValueOnce(
      mockResponse({
        status: 200,
        body: JSON.stringify({ data: { tweetResult: { result: { rest_id: '1' } } } }),
      }),
    );
    const client = new TwitterClient({ cookies: validCookies });
    const clientPrivate = client as unknown as TwitterClient & { getTweetDetailQueryIds: () => Promise<string[]> };
    clientPrivate.getTweetDetailQueryIds = async () => ['td-a', 'td-b'];
    const result = await client.captureTweetDetailPage({
      requestId: 'req-detail-net',
      tweetId: '1',
    });
    expect(result.outcome).toBe('error');
    expect(result.errorKind).toBe('network_error');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('maps normalized likes through a query-id fallback after a transport failure', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('socket down'))
      .mockResolvedValueOnce(mockResponse({ status: 200, body: JSON.stringify(likesEnvelope) }));
    const likes = await clientWithLikesIds(['qid-a', 'qid-b']).getLikes(1);
    expect(likes.success).toBe(true);
    expect(likes.tweets?.[0]?.id).toBe('2');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('uses a conservative future retryAt for invalid or past reset headers', async () => {
    const before = Date.now();
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        status: 429,
        body: 'limited',
        headers: { 'x-rate-limit-reset': '20abc' },
      }),
    );
    const result = await clientWithLikesIds().captureLikesPage({
      requestId: 'req-bad-reset',
      userId: '42',
    });
    expect(result.outcome).toBe('paused');
    expect(result.errorKind).toBe('rate_limited');
    const retryMs = Date.parse(result.retryAt ?? '');
    expect(Number.isNaN(retryMs)).toBe(false);
    expect(retryMs).toBeGreaterThanOrEqual(before + CONSERVATIVE_RETRY_DELAY_MS - 50);
  });

  it('pauses on 429 when text() rejects and does not issue a second likes request', async () => {
    const before = Date.now();
    const persisted: CapturedResponse[] = [];
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ 'retry-after': '60' }),
        text: async () => {
          throw new Error('body closed');
        },
        json: async () => {
          throw new Error('body closed');
        },
      })
      .mockResolvedValueOnce(mockResponse({ status: 200, body: JSON.stringify(likesEnvelope) }));

    const result = await clientWithLikesIds(['qid-a', 'qid-b']).captureLikesPage({
      requestId: 'req-429-text',
      userId: '42',
      onResponse: async (response) => {
        persisted.push(response);
      },
    });

    expect(result.outcome).toBe('paused');
    expect(result.errorKind).toBe('rate_limited');
    expect(result.response).toBeUndefined();
    expect(result.attemptCount).toBe(1);
    expect(persisted).toHaveLength(0);
    const retryMs = Date.parse(result.retryAt ?? '');
    expect(retryMs).toBeGreaterThanOrEqual(before + 60_000 - 50);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('treats a gate denial labeled network_error as fatal and does not transport', async () => {
    let gated = 0;
    mockFetch.mockResolvedValue(mockResponse({ status: 200, body: JSON.stringify(likesEnvelope) }));
    const result = await clientWithLikesIds(['qid-a', 'qid-b']).captureLikesPage({
      requestId: 'req-gate-net',
      userId: '42',
      beforeAttempt: async () => {
        gated += 1;
        if (gated === 1) {
          return { action: 'error', error: 'denied', errorKind: 'network_error' };
        }
        return { action: 'proceed' };
      },
    });
    expect(result.outcome).toBe('error');
    expect(result.errorKind).toBe('network_error');
    expect(result.error).toBe('denied');
    expect(gated).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.attemptCount).toBe(0);
  });

  it('refreshes query ids after an earlier 404 and a later HTTP error', async () => {
    let ids = ['qid-a', 'qid-b'];
    const client = clientWithLikesIds();
    client.getLikesQueryIds = async () => ids;
    client.refreshQueryIds = async () => {
      ids = ['qid-c'];
    };
    mockFetch
      .mockResolvedValueOnce(mockResponse({ status: 404, body: 'gone' }))
      .mockResolvedValueOnce(mockResponse({ status: 500, body: 'boom' }))
      .mockResolvedValueOnce(mockResponse({ status: 200, body: JSON.stringify(likesEnvelope) }));

    const result = await client.captureLikesPage({
      requestId: 'req-404-then-500',
      userId: '42',
    });
    expect(result.outcome).toBe('ok');
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(String(mockFetch.mock.calls[2]?.[0])).toContain('/qid-c/');

    ids = ['qid-a', 'qid-b'];
    mockFetch.mockReset();
    client.getLikesQueryIds = async () => ids;
    client.refreshQueryIds = async () => {
      ids = ['qid-c'];
    };
    mockFetch
      .mockResolvedValueOnce(mockResponse({ status: 404, body: 'gone' }))
      .mockResolvedValueOnce(mockResponse({ status: 500, body: 'boom' }))
      .mockResolvedValueOnce(mockResponse({ status: 200, body: JSON.stringify(likesEnvelope) }));
    const likes = await client.getLikes(1);
    expect(likes.success).toBe(true);
    expect(likes.tweets?.[0]?.id).toBe('2');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('ends the 404 pass after POST HTTP error so refresh runs before the next stale query id', async () => {
    let ids = ['old1', 'old2'];
    const client = new TwitterClient({ cookies: validCookies });
    const clientPrivate = client as TwitterClient & {
      getTweetDetailQueryIds: () => Promise<string[]>;
      refreshQueryIds: () => Promise<void>;
    };
    clientPrivate.getTweetDetailQueryIds = async () => ids;
    clientPrivate.refreshQueryIds = async () => {
      ids = ['fresh'];
    };
    const gate = new CaptureAttemptGate({
      maxAttempts: 3,
      minDelayMs: 0,
      now: () => 0,
      sleep: async () => undefined,
    });
    mockFetch
      .mockResolvedValueOnce(mockResponse({ status: 404, body: 'gone' }))
      .mockResolvedValueOnce(mockResponse({ status: 500, body: 'boom' }))
      .mockResolvedValueOnce(
        mockResponse({
          status: 200,
          body: JSON.stringify({ data: { tweetResult: { result: { rest_id: '9' } } } }),
        }),
      );

    const result = await client.captureTweetDetailPage({
      requestId: 'req-404-post-500-refresh',
      tweetId: '9',
      beforeAttempt: gate.beforeAttempt,
    });

    expect(result.outcome).toBe('ok');
    expect(result.attemptCount).toBe(3);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' });
    expect(String(mockFetch.mock.calls[2]?.[0])).toContain('/fresh/');
    expect(mockFetch.mock.calls.some((call) => String(call[0]).includes('/old2/'))).toBe(false);
  });
});

describe('capture header allowlist', () => {
  it('keeps quota/retry/content headers and drops credentials', () => {
    const headers = new Headers({
      'content-type': 'application/json',
      'content-length': '12',
      'retry-after': '5',
      'x-rate-limit-remaining': '0',
      'x-rate-limit-reset': '9',
      authorization: 'Bearer secret',
      cookie: 'auth_token=secret',
      'x-csrf-token': 'secret',
    });
    expect(pickCaptureHeaders(headers)).toEqual({
      'content-type': 'application/json',
      'content-length': '12',
      'retry-after': '5',
      'x-rate-limit-remaining': '0',
      'x-rate-limit-reset': '9',
    });
    expect(
      pickCaptureHeaders({
        'Content-Type': 'text/plain',
        authorization: 'secret',
      }),
    ).toEqual({ 'content-type': 'text/plain' });
  });
});

describe('parseRetryAt', () => {
  const now = Date.parse('2026-09-08T20:00:00.000Z');

  it('accepts whole numeric future reset epochs', () => {
    expect(parseRetryAt({ 'x-rate-limit-reset': '1890000000' }, now)?.toISOString()).toBe(
      new Date(1_890_000_000 * 1000).toISOString(),
    );
  });

  it('falls back conservatively for invalid, non-whole, past, or unrepresentable reset', () => {
    const conservative = now + CONSERVATIVE_RETRY_DELAY_MS;
    expect(parseRetryAt({ 'x-rate-limit-reset': '20abc' }, now)?.getTime()).toBe(conservative);
    expect(parseRetryAt({ 'x-rate-limit-reset': '1' }, now)?.getTime()).toBe(conservative);
    expect(parseRetryAt({ 'x-rate-limit-reset': '9'.repeat(30) }, now)?.getTime()).toBe(conservative);
    expect(parseRetryAt({ 'x-rate-limit-reset': '20.5' }, now)?.getTime()).toBe(conservative);
  });

  it('rejects malformed Retry-After deltas instead of Date.parse-ing them as past dates', () => {
    expect(parseRetryAt({ 'retry-after': '1.5' }, now)).toBeUndefined();
    expect(parseRetryAt({ 'retry-after': '-1' }, now)).toBeUndefined();
    expect(Number.isNaN(Date.parse('1.5'))).toBe(false);
    expect(Number.isNaN(Date.parse('-1'))).toBe(false);
    expect(parseRetryAt({ 'retry-after': '1.5', 'x-rate-limit-reset': '1890000000' }, now)?.toISOString()).toBe(
      new Date(1_890_000_000 * 1000).toISOString(),
    );
  });

  it('accepts a genuine future IMF HTTP-date and conservatively replaces a past one', () => {
    const conservative = now + CONSERVATIVE_RETRY_DELAY_MS;
    const future = 'Wed, 09 Sep 2026 01:00:00 GMT';
    const past = 'Wed, 06 Nov 1994 08:49:37 GMT';
    expect(parseRetryAt({ 'retry-after': future }, now)?.toISOString()).toBe(new Date(future).toISOString());
    expect(parseRetryAt({ 'retry-after': past }, now)?.getTime()).toBe(conservative);
  });
});
