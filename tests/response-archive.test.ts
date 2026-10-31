import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ArchivedResponse, archiveResponse } from '../src/lib/response-archive.js';
import { TwitterClient } from '../src/lib/twitter-client.js';
import { validCookies } from './twitter-client-fixtures.js';

const originalFetch = global.fetch;
const homeBody = JSON.stringify({ data: { home: { home_timeline_urt: { instructions: [] } } } });

function archivedFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.json.gz'))
    .map((name) => path.join(dir, name));
}

function readEntry(file: string): ArchivedResponse {
  return JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
}

describe('response archive', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'bird-archive-'));
    vi.stubEnv('BIRD_ARCHIVE_DIR', dir);
    global.fetch = vi.fn().mockImplementation(
      async () =>
        new Response(homeBody, {
          status: 200,
          headers: { 'x-rate-limit-remaining': '42' },
        }),
    );
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('archives a timeline response in addition to returning it, without credentials', async () => {
    const client = new TwitterClient({ cookies: validCookies });
    const result = await client.getHomeTimeline(1);
    expect(result.success).toBe(true);

    const files = archivedFiles(dir);
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]).toContain('HomeTimeline');
    const entry = readEntry(files[0] as string);
    expect(entry.body).toBe(homeBody);
    expect(entry.status).toBe(200);
    expect(entry.rateLimit['x-rate-limit-remaining']).toBe('42');

    const raw = gunzipSync(readFileSync(files[0] as string)).toString('utf8');
    expect(raw).not.toContain(validCookies.authToken);
    expect(raw).not.toContain(validCookies.ct0);
  });

  it('skips DMs and account settings', async () => {
    const response = new Response('{}');
    await archiveResponse('https://x.com/i/api/1.1/dm/inbox_initial_state.json', { method: 'GET' }, response);
    await archiveResponse('https://x.com/i/api/account/settings.json', { method: 'GET' }, response);
    await archiveResponse('https://x.com/settings/account', { method: 'GET' }, response);
    expect(archivedFiles(dir)).toEqual([]);
  });

  it('keeps a failed save from failing the read', async () => {
    const blocked = path.join(dir, 'a-file');
    writeFileSync(blocked, '');
    vi.stubEnv('BIRD_ARCHIVE_DIR', blocked);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const client = new TwitterClient({ cookies: validCookies });
    const result = await client.getHomeTimeline(1);

    expect(result.success).toBe(true);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('drops paid ads from parsed tweets but keeps them in the archive', async () => {
    const tweet = (id: string) => ({
      content: {
        itemContent: {
          tweet_results: {
            result: {
              __typename: 'Tweet',
              rest_id: id,
              legacy: { full_text: `tweet ${id}`, created_at: 'Mon Jan 06 00:00:00 +0000 2025' },
              core: {
                user_results: {
                  result: { __typename: 'User', rest_id: 'u1', legacy: { screen_name: 'a', name: 'A' } },
                },
              },
            },
          },
        },
      },
    });
    const body = JSON.stringify({
      data: {
        home: {
          home_timeline_urt: {
            instructions: [
              {
                entries: [
                  { entryId: 'tweet-1', ...tweet('1') },
                  { entryId: 'promoted-tweet-2-abc', ...tweet('2') },
                ],
              },
            ],
          },
        },
      },
    });
    global.fetch = vi.fn().mockImplementation(async () => new Response(body, { status: 200 }));

    const client = new TwitterClient({ cookies: validCookies });
    const result = await client.getHomeTimeline(1);

    expect(result.tweets?.map((t) => t.id)).toEqual(['1']);
    expect(readEntry(archivedFiles(dir)[0] as string).body).toContain('promoted-tweet-2-abc');
  });

  it('is off when configured off', async () => {
    vi.stubEnv('BIRD_ARCHIVE_DIR', 'off');
    await archiveResponse('https://x.com/i/api/graphql/abc/HomeTimeline', { method: 'GET' }, new Response('{}'));
    expect(archivedFiles(dir)).toEqual([]);
  });
});
