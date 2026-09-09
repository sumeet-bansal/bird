import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TwitterClient } from '../src/lib/twitter-client.js';
import { graphqlResponse, validCookies } from './twitter-client-fixtures.js';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('TwitterClient conversation helpers', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  const makeConversationPayload = () => ({
    data: {
      threaded_conversation_with_injections_v2: {
        instructions: [
          {
            entries: [
              {
                content: {
                  itemContent: {
                    tweet_results: {
                      result: {
                        rest_id: '1',
                        legacy: {
                          full_text: 'root',
                          created_at: '2024-01-01T00:00:00Z',
                          reply_count: 0,
                          retweet_count: 0,
                          favorite_count: 0,
                          conversation_id_str: '1',
                        },
                        core: { user_results: { result: { legacy: { screen_name: 'root', name: 'Root' } } } },
                      },
                    },
                  },
                },
              },
              {
                content: {
                  itemContent: {
                    tweet_results: {
                      result: {
                        rest_id: '2',
                        legacy: {
                          full_text: 'child reply',
                          created_at: '2024-01-02T00:00:00Z',
                          reply_count: 0,
                          retweet_count: 0,
                          favorite_count: 0,
                          conversation_id_str: '1',
                          in_reply_to_status_id_str: '1',
                        },
                        core: { user_results: { result: { legacy: { screen_name: 'child', name: 'Child' } } } },
                      },
                    },
                  },
                },
              },
            ],
          },
        ],
      },
    },
  });

  it('getReplies returns only replies to tweet', async () => {
    mockFetch.mockResolvedValue(graphqlResponse(makeConversationPayload()));

    const client = new TwitterClient({ cookies: validCookies });
    const result = await client.getReplies('1');

    expect(result.success).toBe(true);
    expect(result.tweets?.length).toBe(1);
    expect(result.tweets?.[0].id).toBe('2');
  });

  it('getThread returns sorted thread by createdAt', async () => {
    const payload = makeConversationPayload();
    // swap dates to verify sorting
    const legacy =
      payload.data.threaded_conversation_with_injections_v2.instructions[0]?.entries?.[0]?.content?.itemContent
        ?.tweet_results?.result?.legacy;
    if (legacy) {
      legacy.created_at = '2024-01-03T00:00:00Z';
    }

    mockFetch.mockResolvedValue(graphqlResponse(payload));

    const client = new TwitterClient({ cookies: validCookies });
    const result = await client.getThread('2');

    expect(result.success).toBe(true);
    expect(result.tweets?.map((t) => t.id)).toEqual(['2', '1']); // sorted by createdAt asc
  });

  it('getThread includes tweets from timeline module items', async () => {
    const payload = makeConversationPayload();
    payload.data.threaded_conversation_with_injections_v2.instructions[0]?.entries?.push({
      content: {
        items: [
          {
            item: {
              itemContent: {
                tweet_results: {
                  result: {
                    rest_id: '3',
                    legacy: {
                      full_text: 'nested reply',
                      created_at: '2024-01-04T00:00:00Z',
                      reply_count: 0,
                      retweet_count: 0,
                      favorite_count: 0,
                      conversation_id_str: '1',
                      in_reply_to_status_id_str: '1',
                    },
                    core: {
                      user_results: { result: { legacy: { screen_name: 'nested', name: 'Nested' } } },
                    },
                  },
                },
              },
            },
          },
        ],
      },
    });

    mockFetch.mockResolvedValue(graphqlResponse(payload));

    const client = new TwitterClient({ cookies: validCookies });
    const result = await client.getThread('1');

    expect(result.success).toBe(true);
    expect(result.tweets?.map((t) => t.id)).toEqual(['1', '2', '3']);
  });

  it('propagates fetchTweetDetail errors', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'oops',
    });

    const client = new TwitterClient({ cookies: validCookies });
    const result = await client.getThread('1');

    expect(result.success).toBe(false);
    expect(result.error).toContain('HTTP 500');
  });
});
