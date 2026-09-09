import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TwitterClient } from '../src/lib/twitter-client.js';
import { mapTweetResult } from '../src/lib/twitter-client-utils.js';
import { asGraphqlResponse, graphqlResponse, validCookies } from './twitter-client-fixtures.js';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('TwitterClient getTweet', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it('should return tweet data from root tweetResult', async () => {
    mockFetch.mockResolvedValueOnce(
      asGraphqlResponse({
        ok: true,
        json: async () => ({
          data: {
            tweetResult: {
              result: {
                rest_id: '12345',
                legacy: {
                  full_text: 'Root tweet text',
                  created_at: 'Mon Jan 01 00:00:00 +0000 2024',
                  reply_count: 1,
                  retweet_count: 2,
                  favorite_count: 3,
                },
                core: {
                  user_results: {
                    result: {
                      legacy: {
                        screen_name: 'user',
                        name: 'User Name',
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      }),
    );

    const client = new TwitterClient({ cookies: validCookies });
    const result = await client.getTweet('12345');

    expect(result.success).toBe(true);
    expect(result.tweet?.id).toBe('12345');
    expect(result.tweet?.text).toBe('Root tweet text');
    expect(result.tweet?.author.username).toBe('user');
  });

  it('should return tweet data found inside conversation instructions', async () => {
    mockFetch.mockResolvedValueOnce(
      asGraphqlResponse({
        ok: true,
        json: async () => ({
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
                              rest_id: '6789',
                              legacy: {
                                full_text: 'Nested text',
                                created_at: 'Mon Jan 01 00:00:00 +0000 2024',
                                reply_count: 0,
                                retweet_count: 0,
                                favorite_count: 0,
                              },
                              core: {
                                user_results: {
                                  result: {
                                    legacy: {
                                      screen_name: 'nestuser',
                                      name: 'Nested User',
                                    },
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
        }),
      }),
    );

    const client = new TwitterClient({ cookies: validCookies });
    const result = await client.getTweet('6789');

    expect(result.success).toBe(true);
    expect(result.tweet?.text).toBe('Nested text');
    expect(result.tweet?.author.username).toBe('nestuser');
  });

  it('should report HTTP errors from getTweet', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
    });

    const client = new TwitterClient({ cookies: validCookies });
    const result = await client.getTweet('missing');

    expect(result.success).toBe(false);
    expect(result.error).toContain('HTTP 404');
  });

  it('should return article text when present', async () => {
    mockFetch.mockResolvedValueOnce(
      asGraphqlResponse({
        ok: true,
        json: async () => ({
          data: {
            tweetResult: {
              result: {
                rest_id: 'article123',
                legacy: {
                  full_text: '',
                  created_at: 'Mon Jan 01 00:00:00 +0000 2024',
                },
                article: {
                  article_results: {
                    result: {
                      title: '2025 LLM Year in Review',
                      sections: [
                        {
                          items: [
                            { text: 'Intro paragraph of the article.' },
                            { content: { text: 'Second paragraph.' } },
                          ],
                        },
                      ],
                    },
                  },
                },
                core: {
                  user_results: {
                    result: {
                      legacy: {
                        screen_name: 'author',
                        name: 'Article Author',
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      }),
    );

    const client = new TwitterClient({ cookies: validCookies });
    const result = await client.getTweet('article123');

    expect(result.success).toBe(true);
    expect(result.tweet?.text).toBe('2025 LLM Year in Review\n\nIntro paragraph of the article.\n\nSecond paragraph.');
  });

  it('should fall back to user article timeline for plain text', async () => {
    mockFetch
      .mockResolvedValueOnce(
        asGraphqlResponse({
          ok: true,
          json: async () => ({
            data: {
              tweetResult: {
                result: {
                  rest_id: 'article123',
                  legacy: {
                    full_text: '',
                    created_at: 'Mon Jan 01 00:00:00 +0000 2024',
                  },
                  article: {
                    article_results: {
                      result: {
                        title: '2025 LLM Year in Review',
                      },
                    },
                  },
                  core: {
                    user_results: {
                      result: {
                        rest_id: '33836629',
                        legacy: {
                          screen_name: 'author',
                          name: 'Article Author',
                        },
                      },
                    },
                  },
                },
              },
            },
          }),
        }),
      )
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            user: {
              result: {
                timeline: {
                  timeline: {
                    instructions: [
                      {
                        entries: [
                          {
                            content: {
                              itemContent: {
                                tweet_results: {
                                  result: {
                                    rest_id: 'article123',
                                    article: {
                                      article_results: {
                                        result: {
                                          title: '2025 LLM Year in Review',
                                          plain_text: 'Full article body.',
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
          },
        }),
      });

    const client = new TwitterClient({ cookies: validCookies });
    const result = await client.getTweet('article123');

    expect(result.success).toBe(true);
    expect(result.tweet?.text).toBe('2025 LLM Year in Review\n\nFull article body.');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should return note tweet text when present', async () => {
    mockFetch.mockResolvedValueOnce(
      asGraphqlResponse({
        ok: true,
        json: async () => ({
          data: {
            tweetResult: {
              result: {
                rest_id: 'note123',
                legacy: {
                  full_text: '',
                  created_at: 'Mon Jan 01 00:00:00 +0000 2024',
                },
                note_tweet: {
                  note_tweet_results: {
                    result: {
                      text: 'Long form note content.',
                    },
                  },
                },
                core: {
                  user_results: {
                    result: {
                      legacy: {
                        screen_name: 'noter',
                        name: 'Note Author',
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      }),
    );

    const client = new TwitterClient({ cookies: validCookies });
    const result = await client.getTweet('note123');

    expect(result.success).toBe(true);
    expect(result.tweet?.text).toBe('Long form note content.');
  });

  it('retries TweetDetail query id on 404', async () => {
    const payload = {
      data: {
        tweetResult: {
          result: {
            rest_id: '1',
            legacy: {
              full_text: 'hello',
              created_at: '2024-01-01T00:00:00Z',
              reply_count: 0,
              retweet_count: 0,
              favorite_count: 0,
            },
            core: { user_results: { result: { legacy: { screen_name: 'root', name: 'Root' } } } },
          },
        },
      },
    };

    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => '' })
      .mockResolvedValueOnce({ ok: false, status: 404, text: async () => '' })
      .mockResolvedValueOnce(graphqlResponse(payload));

    const client = new TwitterClient({ cookies: validCookies });
    const result = await client.getTweet('1');

    expect(result.success).toBe(true);
    expect(result.tweet?.id).toBe('1');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

describe('TwitterClient quoted tweets', () => {
  const makeTweetResult = (
    id: string,
    text: string,
    username = `user${id}`,
    name = `User ${id}`,
  ): Record<string, unknown> => ({
    rest_id: id,
    legacy: {
      full_text: text,
      created_at: '2024-01-01T00:00:00Z',
      reply_count: 0,
      retweet_count: 0,
      favorite_count: 0,
      conversation_id_str: id,
    },
    core: {
      user_results: {
        result: {
          rest_id: `u${id}`,
          legacy: { screen_name: username, name },
        },
      },
    },
  });

  it('includes one level of quoted tweet by default', () => {
    const quoted = makeTweetResult('2', 'quoted');
    const root = makeTweetResult('1', 'root');
    root.quoted_status_result = { result: quoted };

    const client = new TwitterClient({ cookies: validCookies });
    const mapped = mapTweetResult(root, (client as { quoteDepth: number }).quoteDepth);

    expect(mapped?.quotedTweet?.id).toBe('2');
    expect(mapped?.quotedTweet?.quotedTweet).toBeUndefined();
  });

  it('honors quoteDepth = 0', () => {
    const quoted = makeTweetResult('2', 'quoted');
    const root = makeTweetResult('1', 'root');
    root.quoted_status_result = { result: quoted };

    const client = new TwitterClient({ cookies: validCookies, quoteDepth: 0 });
    const mapped = mapTweetResult(root, (client as { quoteDepth: number }).quoteDepth);

    expect(mapped?.quotedTweet).toBeUndefined();
  });

  it('recurses when quoteDepth > 1', () => {
    const quoted2 = makeTweetResult('3', 'quoted2');
    const quoted1 = makeTweetResult('2', 'quoted1');
    quoted1.quoted_status_result = { result: quoted2 };
    const root = makeTweetResult('1', 'root');
    root.quoted_status_result = { result: quoted1 };

    const client = new TwitterClient({ cookies: validCookies, quoteDepth: 2 });
    const mapped = mapTweetResult(root, (client as { quoteDepth: number }).quoteDepth);

    expect(mapped?.quotedTweet?.id).toBe('2');
    expect(mapped?.quotedTweet?.quotedTweet?.id).toBe('3');
    expect(mapped?.quotedTweet?.quotedTweet?.quotedTweet).toBeUndefined();
  });

  it('unwraps quoted tweet visibility wrappers', () => {
    const quoted = makeTweetResult('2', 'quoted');
    const root = makeTweetResult('1', 'root');
    root.quoted_status_result = {
      result: {
        __typename: 'TweetWithVisibilityResults',
        tweet: quoted,
      },
    };

    const client = new TwitterClient({ cookies: validCookies });
    const mapped = mapTweetResult(root, (client as { quoteDepth: number }).quoteDepth);

    expect(mapped?.quotedTweet?.id).toBe('2');
  });
});
