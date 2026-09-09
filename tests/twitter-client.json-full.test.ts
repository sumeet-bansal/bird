import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TwitterClient } from '../src/lib/twitter-client.js';
import { mapTweetResult, parseTweetsFromInstructions } from '../src/lib/twitter-client-utils.js';
import { graphqlResponse, validCookies } from './twitter-client-fixtures.js';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('mapTweetResult with includeRaw', () => {
  const makeTweetResult = (id: string, text: string, username = `user${id}`) => ({
    rest_id: id,
    legacy: {
      full_text: text,
      created_at: '2024-01-01T00:00:00Z',
      reply_count: 1,
      retweet_count: 2,
      favorite_count: 3,
      conversation_id_str: id,
    },
    core: {
      user_results: {
        result: {
          rest_id: `u${id}`,
          legacy: { screen_name: username, name: `User ${id}` },
        },
      },
    },
    // Extra fields that should only be in _raw
    entities: {
      urls: [{ url: 'https://t.co/abc', expanded_url: 'https://example.com' }],
      hashtags: [{ text: 'test' }],
    },
    extended_entities: {
      media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/test.jpg' }],
    },
  });

  it('does not include _raw by default', () => {
    const result = makeTweetResult('1', 'hello');
    const mapped = mapTweetResult(result, { quoteDepth: 1 });

    expect(mapped).toBeDefined();
    expect(mapped?.id).toBe('1');
    expect(mapped?.text).toBe('hello');
    expect(mapped?._raw).toBeUndefined();
  });

  it('does not include _raw when includeRaw is false', () => {
    const result = makeTweetResult('1', 'hello');
    const mapped = mapTweetResult(result, { quoteDepth: 1, includeRaw: false });

    expect(mapped).toBeDefined();
    expect(mapped?._raw).toBeUndefined();
  });

  it('includes _raw when includeRaw is true', () => {
    const result = makeTweetResult('1', 'hello');
    const mapped = mapTweetResult(result, { quoteDepth: 1, includeRaw: true });

    expect(mapped).toBeDefined();
    expect(mapped?.id).toBe('1');
    expect(mapped?.text).toBe('hello');
    expect(mapped?._raw).toBeDefined();
    expect(mapped?._raw).toBe(result);
    // Verify the raw data contains fields not in the curated output
    expect(mapped?._raw?.entities).toBeDefined();
    expect(mapped?._raw?.extended_entities).toBeDefined();
  });

  it('includes _raw in quoted tweets when includeRaw is true', () => {
    const quoted = makeTweetResult('2', 'quoted tweet');
    const root = makeTweetResult('1', 'root tweet');
    (root as Record<string, unknown>).quoted_status_result = { result: quoted };

    const mapped = mapTweetResult(root, { quoteDepth: 1, includeRaw: true });

    expect(mapped?._raw).toBeDefined();
    expect(mapped?.quotedTweet?._raw).toBeDefined();
    expect(mapped?.quotedTweet?._raw).toBe(quoted);
  });

  it('does not include _raw in quoted tweets when includeRaw is false', () => {
    const quoted = makeTweetResult('2', 'quoted tweet');
    const root = makeTweetResult('1', 'root tweet');
    (root as Record<string, unknown>).quoted_status_result = { result: quoted };

    const mapped = mapTweetResult(root, { quoteDepth: 1, includeRaw: false });

    expect(mapped?._raw).toBeUndefined();
    expect(mapped?.quotedTweet?._raw).toBeUndefined();
  });

  it('works with legacy number-only quoteDepth parameter', () => {
    const result = makeTweetResult('1', 'hello');
    // This tests backward compatibility
    const mapped = mapTweetResult(result, 1);

    expect(mapped).toBeDefined();
    expect(mapped?.id).toBe('1');
    expect(mapped?._raw).toBeUndefined();
  });
});

describe('parseTweetsFromInstructions with includeRaw', () => {
  const makeInstruction = (tweets: Array<{ id: string; text: string }>) => [
    {
      entries: tweets.map((t) => ({
        content: {
          itemContent: {
            tweet_results: {
              result: {
                rest_id: t.id,
                legacy: {
                  full_text: t.text,
                  created_at: '2024-01-01T00:00:00Z',
                },
                core: {
                  user_results: {
                    result: {
                      legacy: { screen_name: `user${t.id}`, name: `User ${t.id}` },
                    },
                  },
                },
              },
            },
          },
        },
      })),
    },
  ];

  it('does not include _raw by default', () => {
    const instructions = makeInstruction([{ id: '1', text: 'tweet 1' }]);
    const tweets = parseTweetsFromInstructions(instructions, { quoteDepth: 1 });

    expect(tweets).toHaveLength(1);
    expect(tweets[0]._raw).toBeUndefined();
  });

  it('includes _raw when includeRaw is true', () => {
    const instructions = makeInstruction([
      { id: '1', text: 'tweet 1' },
      { id: '2', text: 'tweet 2' },
    ]);
    const tweets = parseTweetsFromInstructions(instructions, { quoteDepth: 1, includeRaw: true });

    expect(tweets).toHaveLength(2);
    expect(tweets[0]._raw).toBeDefined();
    expect(tweets[0]._raw?.rest_id).toBe('1');
    expect(tweets[1]._raw).toBeDefined();
    expect(tweets[1]._raw?.rest_id).toBe('2');
  });

  it('works with legacy number-only quoteDepth parameter', () => {
    const instructions = makeInstruction([{ id: '1', text: 'tweet 1' }]);
    // This tests backward compatibility
    const tweets = parseTweetsFromInstructions(instructions, 1);

    expect(tweets).toHaveLength(1);
    expect(tweets[0]._raw).toBeUndefined();
  });
});

describe('TwitterClient getTweet with includeRaw option', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  const mockTweetResponse = {
    data: {
      tweetResult: {
        result: {
          rest_id: '12345',
          legacy: {
            full_text: 'Test tweet',
            created_at: 'Mon Jan 01 00:00:00 +0000 2024',
            reply_count: 1,
            retweet_count: 2,
            favorite_count: 3,
          },
          core: {
            user_results: {
              result: {
                rest_id: 'u123',
                legacy: { screen_name: 'testuser', name: 'Test User' },
              },
            },
          },
          entities: {
            urls: [{ url: 'https://t.co/abc', expanded_url: 'https://example.com' }],
          },
        },
      },
    },
  };

  it('does not include _raw by default', async () => {
    mockFetch.mockResolvedValueOnce(graphqlResponse(mockTweetResponse));

    const client = new TwitterClient({ cookies: validCookies });
    const result = await client.getTweet('12345');

    expect(result.success).toBe(true);
    expect(result.tweet?._raw).toBeUndefined();
  });

  it('includes _raw when includeRaw option is true', async () => {
    mockFetch.mockResolvedValueOnce(graphqlResponse(mockTweetResponse));

    const client = new TwitterClient({ cookies: validCookies });
    const result = await client.getTweet('12345', { includeRaw: true });

    expect(result.success).toBe(true);
    expect(result.tweet?._raw).toBeDefined();
    expect(result.tweet?._raw?.rest_id).toBe('12345');
    expect(result.tweet?._raw?.entities).toBeDefined();
  });
});

describe('TwitterClient getReplies with includeRaw option', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  const mockRepliesResponse = {
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
                        rest_id: '99999',
                        legacy: {
                          full_text: 'A reply',
                          created_at: 'Mon Jan 01 00:00:00 +0000 2024',
                          in_reply_to_status_id_str: '12345',
                        },
                        core: {
                          user_results: {
                            result: {
                              legacy: { screen_name: 'replier', name: 'Replier' },
                            },
                          },
                        },
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
  };

  it('includes _raw in replies when includeRaw is true', async () => {
    mockFetch.mockResolvedValueOnce(graphqlResponse(mockRepliesResponse));

    const client = new TwitterClient({ cookies: validCookies });
    const result = await client.getReplies('12345', { includeRaw: true });

    expect(result.success).toBe(true);
    expect(result.tweets).toHaveLength(1);
    expect(result.tweets?.[0]._raw).toBeDefined();
    expect(result.tweets?.[0]._raw?.rest_id).toBe('99999');
  });
});

describe('TwitterClient getThread with includeRaw option', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  const mockThreadResponse = {
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
                        rest_id: '12345',
                        legacy: {
                          full_text: 'Thread start',
                          created_at: 'Mon Jan 01 00:00:00 +0000 2024',
                          conversation_id_str: '12345',
                        },
                        core: {
                          user_results: {
                            result: {
                              legacy: { screen_name: 'author', name: 'Author' },
                            },
                          },
                        },
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
  };

  it('includes _raw in thread tweets when includeRaw is true', async () => {
    mockFetch.mockResolvedValueOnce(graphqlResponse(mockThreadResponse));

    const client = new TwitterClient({ cookies: validCookies });
    const result = await client.getThread('12345', { includeRaw: true });

    expect(result.success).toBe(true);
    expect(result.tweets).toHaveLength(1);
    expect(result.tweets?.[0]._raw).toBeDefined();
  });
});

describe('TwitterClient search with includeRaw option', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  const mockSearchResponse = {
    data: {
      search_by_raw_query: {
        search_timeline: {
          timeline: {
            instructions: [
              {
                entries: [
                  {
                    content: {
                      itemContent: {
                        tweet_results: {
                          result: {
                            rest_id: '11111',
                            legacy: {
                              full_text: 'Search result',
                              created_at: 'Mon Jan 01 00:00:00 +0000 2024',
                            },
                            core: {
                              user_results: {
                                result: {
                                  legacy: { screen_name: 'found', name: 'Found User' },
                                },
                              },
                            },
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
      },
    },
  };

  it('includes _raw in search results when includeRaw is true', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockSearchResponse,
    });

    const client = new TwitterClient({ cookies: validCookies });
    const result = await client.search('test query', 10, { includeRaw: true });

    expect(result.success).toBe(true);
    expect(result.tweets).toHaveLength(1);
    expect(result.tweets?.[0]._raw).toBeDefined();
    expect(result.tweets?.[0]._raw?.rest_id).toBe('11111');
  });

  it('does not include _raw in search results by default', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockSearchResponse,
    });

    const client = new TwitterClient({ cookies: validCookies });
    const result = await client.search('test query', 10);

    expect(result.success).toBe(true);
    expect(result.tweets?.[0]._raw).toBeUndefined();
  });
});

describe('--json-full flag behavior (without --json)', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  const mockTweetResponse = {
    data: {
      tweetResult: {
        result: {
          rest_id: '12345',
          legacy: {
            full_text: 'Test tweet',
            created_at: 'Mon Jan 01 00:00:00 +0000 2024',
          },
          core: {
            user_results: {
              result: {
                legacy: { screen_name: 'testuser', name: 'Test User' },
              },
            },
          },
        },
      },
    },
  };

  it('includeRaw works independently without requiring other json options', async () => {
    // This tests that --json-full alone (without --json) will include _raw
    // The CLI handles output format separately, but the client should work with just includeRaw
    mockFetch.mockResolvedValueOnce(graphqlResponse(mockTweetResponse));

    const client = new TwitterClient({ cookies: validCookies });
    // Only passing includeRaw: true, simulating --json-full without --json
    const result = await client.getTweet('12345', { includeRaw: true });

    expect(result.success).toBe(true);
    expect(result.tweet).toBeDefined();
    expect(result.tweet?._raw).toBeDefined();
    // Verify the result is JSON-serializable (would be used for JSON output)
    const serialized = JSON.stringify(result.tweet);
    expect(serialized).toContain('"_raw"');
    expect(serialized).toContain('"id":"12345"');
  });
});
