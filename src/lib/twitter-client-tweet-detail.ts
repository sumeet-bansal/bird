import { paginateCursor } from './paginate-cursor.js';
import type { AbstractConstructor, Mixin, TwitterClientBase } from './twitter-client-base.js';
import { TWITTER_API_BASE } from './twitter-client-constants.js';
import { buildArticleFeatures, buildArticleFieldToggles } from './twitter-client-features.js';
import type { PageResult, RawPageHooks } from './twitter-client-page-request.js';
import {
  buildTweetDetailPageFeatures,
  buildTweetDetailPageFieldToggles,
  buildTweetDetailPageVariables,
  captureGraphqlPage,
  getTweetDetailData,
  pageResultWithoutTransport,
} from './twitter-client-page-request.js';
import type { GetTweetResult, GraphqlTweetResult, SearchResult, TweetData } from './twitter-client-types.js';
import {
  extractArticleText,
  extractCursorFromInstructions,
  findTweetInInstructions,
  firstText,
  mapTweetResult,
  parseTweetsFromInstructions,
} from './twitter-client-utils.js';

/** Options for tweet fetching methods */
export interface TweetFetchOptions {
  /** Include raw GraphQL response in `_raw` field */
  includeRaw?: boolean;
}

/** Options for paginated tweet detail fetch */
export interface TweetDetailPaginationOptions extends TweetFetchOptions {
  /** Maximum number of pages to fetch (default: unlimited when using pagination) */
  maxPages?: number;
  /** Starting cursor for pagination (resume from previous fetch) */
  cursor?: string;
  /** Delay in milliseconds between page fetches (default: 1000) */
  pageDelayMs?: number;
}

/** Options for a raw single-page TweetDetail capture. */
export interface CaptureTweetDetailPageOptions extends RawPageHooks {
  tweetId: string;
  cursor?: string;
}

export interface TwitterClientTweetDetailMethods {
  getTweet(tweetId: string, options?: TweetFetchOptions): Promise<GetTweetResult>;
  getReplies(tweetId: string, options?: TweetFetchOptions): Promise<SearchResult>;
  getThread(tweetId: string, options?: TweetFetchOptions): Promise<SearchResult>;
  getRepliesPaged(tweetId: string, options?: TweetDetailPaginationOptions): Promise<SearchResult>;
  getThreadPaged(tweetId: string, options?: TweetDetailPaginationOptions): Promise<SearchResult>;
  /** Fetch one raw TweetDetail GraphQL page. Persistence (`onResponse`) runs before JSON parse/retry. */
  captureTweetDetailPage(options: CaptureTweetDetailPageOptions): Promise<PageResult>;
}

export function withTweetDetails<TBase extends AbstractConstructor<TwitterClientBase>>(
  Base: TBase,
): Mixin<TBase, TwitterClientTweetDetailMethods> {
  abstract class TwitterClientTweetDetails extends Base {
    // biome-ignore lint/complexity/noUselessConstructor lint/suspicious/noExplicitAny: TS mixin constructor requirement.
    constructor(...args: any[]) {
      super(...args);
    }

    private async fetchUserArticlePlainText(
      userId: string,
      tweetId: string,
    ): Promise<{ title?: string; plainText?: string }> {
      const variables = {
        userId,
        count: 20,
        includePromotedContent: true,
        withVoice: true,
        withQuickPromoteEligibilityTweetFields: true,
        withBirdwatchNotes: true,
        withCommunity: true,
        withSafetyModeUserFields: true,
        withSuperFollowsUserFields: true,
        withDownvotePerspective: false,
        withReactionsMetadata: false,
        withReactionsPerspective: false,
        withSuperFollowsTweetFields: true,
        withSuperFollowsReplyCount: false,
        withClientEventToken: false,
      };

      const params = new URLSearchParams({
        variables: JSON.stringify(variables),
        features: JSON.stringify(buildArticleFeatures()),
        fieldToggles: JSON.stringify(buildArticleFieldToggles()),
      });

      const queryId = await this.getQueryId('UserArticlesTweets');
      const url = `${TWITTER_API_BASE}/${queryId}/UserArticlesTweets?${params.toString()}`;

      try {
        const response = await this.fetchWithTimeout(url, { method: 'GET', headers: this.getHeaders() });
        if (!response.ok) {
          return {};
        }

        const data = (await response.json()) as {
          data?: {
            user?: {
              result?: {
                timeline?: {
                  timeline?: {
                    instructions?: Array<{
                      entries?: Array<{
                        content?: {
                          itemContent?: {
                            tweet_results?: { result?: GraphqlTweetResult };
                          };
                        };
                      }>;
                    }>;
                  };
                };
              };
            };
          };
        };

        const instructions = data.data?.user?.result?.timeline?.timeline?.instructions ?? [];
        for (const instruction of instructions) {
          for (const entry of instruction.entries ?? []) {
            const result = entry.content?.itemContent?.tweet_results?.result;
            if (result?.rest_id !== tweetId) {
              continue;
            }
            const articleResult = result.article?.article_results?.result;
            const title = firstText(articleResult?.title, result.article?.title);
            const plainText = firstText(articleResult?.plain_text, result.article?.plain_text);
            return { title, plainText };
          }
        }
      } catch {
        return {};
      }

      return {};
    }

    /**
     * Raw single-page TweetDetail capture. Selected-endpoint attempts are gated
     * by `beforeAttempt` (GET, POST fallback, query-ID fallback, and feature repair).
     */
    async captureTweetDetailPage(options: CaptureTweetDetailPageOptions): Promise<PageResult> {
      if (!options.requestId) {
        return pageResultWithoutTransport({
          outcome: 'error',
          error: 'requestId is required',
          errorKind: 'invalid_request',
        });
      }
      if (!options.tweetId) {
        return pageResultWithoutTransport({
          outcome: 'error',
          error: 'tweetId is required',
          errorKind: 'invalid_request',
        });
      }

      return captureGraphqlPage({
        transport: {
          fetchWithTimeout: (url, init) => this.fetchWithTimeout(url, init),
          getHeaders: () => this.getHeaders(),
          refreshQueryIds: () => this.refreshQueryIds(),
        },
        operation: 'TweetDetail',
        requestId: options.requestId,
        getQueryIds: () => this.getTweetDetailQueryIds(),
        buildVariables: () => buildTweetDetailPageVariables(options.tweetId, options.cursor),
        buildFeatures: () => buildTweetDetailPageFeatures(),
        fieldToggles: () => buildTweetDetailPageFieldToggles(),
        allowPostFallback: true,
        featureSetName: 'tweetDetail',
        beforeAttempt: options.beforeAttempt,
        onResponse: options.onResponse,
      });
    }

    private async fetchTweetDetail(
      tweetId: string,
      cursor?: string,
    ): Promise<
      | {
          success: true;
          data: {
            tweetResult?: { result?: GraphqlTweetResult };
            threaded_conversation_with_injections_v2?: {
              instructions?: Array<{
                entries?: Array<{
                  content?: {
                    itemContent?: {
                      tweet_results?: {
                        result?: GraphqlTweetResult;
                      };
                    };
                  };
                }>;
              }>;
            };
          };
        }
      | { success: false; error: string }
    > {
      const page = await this.captureTweetDetailPage({
        requestId: `normalized-tweet-detail-${tweetId}`,
        tweetId,
        cursor,
      });
      if (page.outcome !== 'ok') {
        return { success: false, error: page.error ?? 'Unknown error fetching tweet detail' };
      }
      if (page.envelope === undefined && page.response?.status === 200) {
        return { success: false, error: 'Invalid JSON' };
      }
      const envelope = page.envelope as { errors?: Array<{ message: string }> } | undefined;
      const data = getTweetDetailData(page.envelope);
      const hasUsableData = Boolean(
        data.tweetResult?.result || data.threaded_conversation_with_injections_v2?.instructions?.length,
      );
      if (envelope?.errors && envelope.errors.length > 0 && !hasUsableData) {
        return { success: false, error: envelope.errors.map((entry) => entry.message).join(', ') };
      }
      return {
        success: true,
        data: data as {
          tweetResult?: { result?: GraphqlTweetResult };
          threaded_conversation_with_injections_v2?: {
            instructions?: Array<{
              entries?: Array<{
                content?: {
                  itemContent?: {
                    tweet_results?: {
                      result?: GraphqlTweetResult;
                    };
                  };
                };
              }>;
            }>;
          };
        },
      };
    }

    /**
     * Get tweet details by ID
     */
    async getTweet(tweetId: string, options: TweetFetchOptions = {}): Promise<GetTweetResult> {
      const { includeRaw = false } = options;
      const response = await this.fetchTweetDetail(tweetId);
      if (!response.success) {
        return response;
      }

      const tweetResult =
        (response.data.tweetResult as { result?: GraphqlTweetResult } | undefined)?.result ??
        findTweetInInstructions(
          response.data.threaded_conversation_with_injections_v2?.instructions as
            | Array<{
                entries?: Array<{
                  content?: {
                    itemContent?: {
                      tweet_results?: {
                        result?: GraphqlTweetResult;
                      };
                    };
                  };
                }>;
              }>
            | undefined,
          tweetId,
        );

      const mapped = mapTweetResult(tweetResult, { quoteDepth: this.quoteDepth, includeRaw });
      if (mapped) {
        if (tweetResult?.article) {
          const title = firstText(tweetResult.article.article_results?.result?.title, tweetResult.article.title);
          const articleText = extractArticleText(tweetResult);
          if (title && (!articleText || articleText.trim() === title.trim())) {
            const userId = tweetResult.core?.user_results?.result?.rest_id;
            if (userId) {
              const fallback = await this.fetchUserArticlePlainText(userId, tweetId);
              if (fallback.plainText) {
                mapped.text = fallback.title ? `${fallback.title}\n\n${fallback.plainText}` : fallback.plainText;
              }
            }
          }
        }
        return { success: true, tweet: mapped };
      }
      return { success: false, error: 'Tweet not found in response' };
    }

    /**
     * Get replies to a tweet by ID
     */
    async getReplies(tweetId: string, options: TweetFetchOptions = {}): Promise<SearchResult> {
      const { includeRaw = false } = options;
      const response = await this.fetchTweetDetail(tweetId);
      if (!response.success) {
        return response;
      }

      const instructions = response.data.threaded_conversation_with_injections_v2?.instructions;
      const tweets = parseTweetsFromInstructions(instructions, { quoteDepth: this.quoteDepth, includeRaw });
      const replies = tweets.filter((tweet) => tweet.inReplyToStatusId === tweetId);

      return { success: true, tweets: replies };
    }

    /**
     * Get full conversation thread for a tweet ID
     */
    async getThread(tweetId: string, options: TweetFetchOptions = {}): Promise<SearchResult> {
      const { includeRaw = false } = options;
      const response = await this.fetchTweetDetail(tweetId);
      if (!response.success) {
        return response;
      }

      const instructions = response.data.threaded_conversation_with_injections_v2?.instructions;
      const tweets = parseTweetsFromInstructions(instructions, { quoteDepth: this.quoteDepth, includeRaw });

      const target = tweets.find((t) => t.id === tweetId);
      const rootId = target?.conversationId || tweetId;
      const thread = tweets.filter((tweet) => tweet.conversationId === rootId);

      thread.sort((a, b) => {
        const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
        const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
        return aTime - bTime;
      });

      return { success: true, tweets: thread };
    }

    /**
     * Get replies to a tweet with pagination support
     */
    async getRepliesPaged(tweetId: string, options: TweetDetailPaginationOptions = {}): Promise<SearchResult> {
      const { includeRaw = false, maxPages, pageDelayMs = 1000 } = options;

      const result = await paginateCursor<TweetData>({
        cursor: options.cursor,
        maxPages,
        pageDelayMs,
        sleep: async (ms) => this.sleep(ms),
        getKey: (tweet) => tweet.id,
        fetchPage: async (cursor) => {
          const response = await this.fetchTweetDetail(tweetId, cursor);
          if (!response.success) {
            return response;
          }

          const instructions = response.data.threaded_conversation_with_injections_v2?.instructions;
          const tweets = parseTweetsFromInstructions(instructions, { quoteDepth: this.quoteDepth, includeRaw });
          const replies = tweets.filter((tweet) => tweet.inReplyToStatusId === tweetId);
          const pageCursor = extractCursorFromInstructions(instructions);

          return { success: true as const, items: replies, cursor: pageCursor };
        },
      });

      if (result.success) {
        return { success: true, tweets: result.items, nextCursor: result.nextCursor };
      }

      if (result.items) {
        return { success: false, tweets: result.items, nextCursor: result.nextCursor, error: result.error };
      }

      return { success: false, error: result.error };
    }

    /**
     * Get full conversation thread with pagination support
     */
    async getThreadPaged(tweetId: string, options: TweetDetailPaginationOptions = {}): Promise<SearchResult> {
      const { includeRaw = false, maxPages, pageDelayMs = 1000 } = options;
      let rootId: string | undefined;

      const result = await paginateCursor<TweetData>({
        cursor: options.cursor,
        maxPages,
        pageDelayMs,
        sleep: async (ms) => this.sleep(ms),
        getKey: (tweet) => tweet.id,
        fetchPage: async (cursor) => {
          const response = await this.fetchTweetDetail(tweetId, cursor);
          if (!response.success) {
            return response;
          }

          const instructions = response.data.threaded_conversation_with_injections_v2?.instructions;
          const tweets = parseTweetsFromInstructions(instructions, { quoteDepth: this.quoteDepth, includeRaw });

          if (!rootId) {
            const target = tweets.find((t) => t.id === tweetId);
            rootId = target?.conversationId || tweetId;
          }

          const threadTweets = tweets.filter((tweet) => tweet.conversationId === rootId);
          const pageCursor = extractCursorFromInstructions(instructions);

          return { success: true as const, items: threadTweets, cursor: pageCursor };
        },
      });

      const sortedTweets = (result.items ?? []).slice().sort((a, b) => {
        const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
        const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
        return aTime - bTime;
      });

      if (result.success) {
        return { success: true, tweets: sortedTweets, nextCursor: result.nextCursor };
      }

      if (result.items) {
        return { success: false, tweets: sortedTweets, nextCursor: result.nextCursor, error: result.error };
      }

      return { success: false, error: result.error };
    }
  }

  return TwitterClientTweetDetails;
}
