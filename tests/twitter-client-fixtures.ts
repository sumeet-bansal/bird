import type { TwitterClient } from '../src/lib/twitter-client.js';

export const validCookies = {
  authToken: 'test_auth_token',
  ct0: 'test_ct0_token',
  cookieHeader: 'auth_token=test_auth_token; ct0=test_ct0_token',
  source: 'test',
};

/** Standard Response-like GraphQL fixture: always has numeric status and text(). */
export function graphqlResponse(
  payload: unknown,
  init: { status?: number; ok?: boolean; headers?: HeadersInit; body?: string } = {},
): {
  ok: boolean;
  status: number;
  headers: Headers;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
} {
  const status = init.status ?? 200;
  const body = init.body ?? JSON.stringify(payload);
  return {
    ok: init.ok ?? (status >= 200 && status < 300),
    status,
    headers: new Headers(init.headers),
    text: async () => body,
    json: async () => payload,
  };
}

/** Fill a json-only test mock into a standard Response-like object. */
export function asGraphqlResponse(mock: {
  ok?: boolean;
  status?: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
  headers?: HeadersInit;
}): {
  ok: boolean;
  status: number;
  headers: Headers;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
} {
  const status = mock.status ?? 200;
  const json = mock.json ?? (async () => ({}));
  return {
    ok: mock.ok ?? (status >= 200 && status < 300),
    status,
    headers: new Headers(mock.headers),
    json,
    text: mock.text ?? (async () => JSON.stringify(await json())),
  };
}

export type TwitterClientPrivate = TwitterClient & {
  getCurrentUser: () => Promise<{
    success: boolean;
    user?: { id: string; username: string; name: string };
    error?: string;
  }>;
  getLikesQueryIds: () => Promise<string[]>;
  getListTimelineQueryIds: () => Promise<string[]>;
  getListOwnershipsQueryIds: () => Promise<string[]>;
  getListMembershipsQueryIds: () => Promise<string[]>;
  refreshQueryIds: () => Promise<void>;
};
