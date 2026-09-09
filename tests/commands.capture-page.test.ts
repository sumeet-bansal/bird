import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../src/cli/program.js';
import type { CliContext } from '../src/cli/shared.js';
import { createCliContext } from '../src/cli/shared.js';
import {
  parseCaptureOperation,
  parseCount,
  parseIsoTime,
  parseRequestId,
  registerCapturePageCommand,
} from '../src/commands/capture-page.js';
import { TwitterClient } from '../src/lib/twitter-client.js';
import type { CapturedResponse, PageResult } from '../src/lib/twitter-client-page-request.js';

const baseCtx = {
  resolveTimeoutFromOptions: () => undefined,
  resolveQuoteDepthFromOptions: () => 1,
  resolveCredentialsFromOptions: async () => ({
    cookies: { authToken: 'auth-secret', ct0: 'ct0-secret', cookieHeader: 'auth_token=auth-secret; ct0=ct0-secret' },
    warnings: [],
  }),
  p: () => '',
} as unknown as CliContext;

function capturedResponse(overrides: Partial<CapturedResponse> = {}): CapturedResponse {
  return {
    schemaVersion: 1,
    requestId: 'task-1',
    attemptId: randomUUID(),
    operation: 'Likes',
    queryId: 'qid',
    method: 'GET',
    variables: { userId: '42', count: 20 },
    fetchedAt: '2026-09-08T18:00:00.000Z',
    status: 200,
    headers: { 'content-type': 'application/json', 'x-rate-limit-remaining': '499' },
    body: '{"data":{"ok":true}}',
    ...overrides,
  };
}

async function parseCapture(args: string[], ctx: CliContext = baseCtx): Promise<{ program: Command }> {
  const program = new Command();
  registerCapturePageCommand(program, ctx);
  await program.parseAsync(['node', 'bird', ...args]);
  return { program };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('capture-page parsers', () => {
  it('validates request ids, counts, operations, and ISO times', () => {
    expect(parseRequestId('task-1_ok.id').ok).toBe(true);
    expect(parseRequestId('../etc/passwd').ok).toBe(false);
    expect(parseRequestId('has space').ok).toBe(false);
    expect(parseCount('20').ok).toBe(true);
    expect(parseCount('0').ok).toBe(false);
    expect(parseCount('21').ok).toBe(false);
    expect(parseCount('20abc').ok).toBe(false);
    expect(parseCount('20.5').ok).toBe(false);
    expect(parseCount(' 20').ok).toBe(false);
    expect(parseCaptureOperation('likes')).toEqual({ ok: true, value: 'Likes' });
    expect(parseCaptureOperation('detail')).toEqual({ ok: true, value: 'TweetDetail' });
    expect(parseCaptureOperation('other').ok).toBe(false);
    expect(parseIsoTime(undefined).ok).toBe(true);
    expect(parseIsoTime('2026-09-08T20:00:00.000Z').ok).toBe(true);
    expect(parseIsoTime('2026-09-08T20:00:00.000+00:00').ok).toBe(true);
    expect(parseIsoTime('not-a-date').ok).toBe(false);
    expect(parseIsoTime('2026-09-08').ok).toBe(false);
    expect(parseIsoTime('September 8, 2026').ok).toBe(false);
    expect(parseIsoTime('2026-09-08T20:00:00.000Z extra').ok).toBe(false);
    expect(parseIsoTime('2026-02-30T12:00:00.000Z').ok).toBe(false);
    expect(parseIsoTime('2026-02-30T12:00:00.000+00:00').ok).toBe(false);
  });
});

describe('capture-page command', () => {
  it('registers on the program and lists in help', () => {
    const ctx = createCliContext([]);
    const program = createProgram(ctx);
    expect(program.commands.some((command) => command.name() === 'capture-page')).toBe(true);
    let help = '';
    program.configureOutput({
      writeOut: (chunk) => {
        help += chunk;
      },
      writeErr: () => {},
    });
    const cmd = program.commands.find((command) => command.name() === 'capture-page');
    cmd?.configureOutput({
      writeOut: (chunk) => {
        help += chunk;
      },
      writeErr: () => {},
    });
    cmd?.outputHelp();
    expect(help).toContain('--capture-dir');
    expect(help).toContain('--request-id');
    expect(help).toContain('--user-id');
  });

  it('rejects likes without --user-id and invalid request ids', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      parseCapture(['capture-page', 'likes', '--capture-dir', '/tmp', '--request-id', 'ok']),
    ).rejects.toThrow('exit 1');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--user-id is required'));

    await expect(
      parseCapture(['capture-page', 'likes', '--user-id', '1', '--capture-dir', '/tmp', '--request-id', 'bad/id']),
    ).rejects.toThrow('exit 1');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('filename-safe'));

    exitSpy.mockRestore();
  });

  it('writes atomic artifacts, stdout manifest, and keeps credentials off both streams', async () => {
    const dir = path.join(os.tmpdir(), `bird-capture-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    const response = capturedResponse({
      attemptId: '11111111-1111-4111-8111-111111111111',
      headers: {
        'content-type': 'application/json',
        authorization: 'should-not-land',
      },
    });
    vi.spyOn(TwitterClient.prototype, 'captureLikesPage').mockImplementation(async (options) => {
      if (options.onResponse) {
        await options.onResponse({
          ...response,
          headers: { 'content-type': 'application/json' },
        });
      }
      return {
        outcome: 'ok',
        response: { ...response, headers: { 'content-type': 'application/json' } },
        envelope: { data: { ok: true } },
        attemptCount: 1,
      } satisfies PageResult;
    });

    const logs: string[] = [];
    const errors: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
      logs.push(String(message));
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
      errors.push(String(message));
    });

    await parseCapture([
      'capture-page',
      'likes',
      '--user-id',
      '2917296176',
      '--count',
      '20',
      '--capture-dir',
      dir,
      '--request-id',
      'task-1',
      '--max-attempts',
      '3',
      '--min-delay-ms',
      '0',
    ]);

    const files = await readdir(dir);
    expect(files).toEqual(['capture-11111111-1111-4111-8111-111111111111.json']);
    const artifact = JSON.parse(await readFile(path.join(dir, files[0] ?? ''), 'utf8')) as CapturedResponse;
    expect(artifact.body).toBe('{"data":{"ok":true}}');
    expect(artifact.headers.authorization).toBeUndefined();
    expect(JSON.stringify(artifact)).not.toContain('auth-secret');
    expect(JSON.stringify(artifact)).not.toContain('ct0-secret');

    expect(logs).toHaveLength(1);
    const manifest = JSON.parse(logs[0] ?? '') as {
      outcome: string;
      responses: string[];
      attemptCount: number;
      finalResponse?: string;
      envelope?: unknown;
    };
    expect(manifest.outcome).toBe('ok');
    expect(manifest.responses).toEqual(files);
    expect(manifest.attemptCount).toBe(1);
    expect(manifest.finalResponse).toBe(files[0]);
    expect(manifest.envelope).toBeUndefined();
    expect(logs[0]).not.toContain('auth-secret');
    expect(errors.join('\n')).not.toContain('auth-secret');

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('emits a paused manifest on stdout and exits 2', async () => {
    const dir = path.join(os.tmpdir(), `bird-capture-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    const response = capturedResponse({
      attemptId: '22222222-2222-4222-8222-222222222222',
      status: 429,
      body: 'limited',
    });
    vi.spyOn(TwitterClient.prototype, 'captureTweetDetailPage').mockImplementation(async (options) => {
      if (options.onResponse) {
        await options.onResponse(response);
      }
      return {
        outcome: 'paused',
        response,
        error: 'HTTP 429',
        errorKind: 'rate_limited',
        retryAt: '2026-09-08T21:00:00.000Z',
        attemptCount: 1,
      } satisfies PageResult;
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const logs: string[] = [];
    const errors: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
      logs.push(String(message));
    });
    vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
      errors.push(String(message));
    });

    await expect(
      parseCapture([
        'capture-page',
        'detail',
        '--tweet-id',
        '99',
        '--capture-dir',
        dir,
        '--request-id',
        'task-pause',
        '--min-delay-ms',
        '0',
      ]),
    ).rejects.toThrow('exit 2');

    expect(logs).toHaveLength(1);
    const manifest = JSON.parse(logs[0] ?? '') as { outcome: string; retryAt?: string; errorKind?: string };
    expect(manifest.outcome).toBe('paused');
    expect(manifest.retryAt).toBe('2026-09-08T21:00:00.000Z');
    expect(manifest.errorKind).toBe('rate_limited');
    expect(errors.some((line) => line.includes('paused'))).toBe(true);
    exitSpy.mockRestore();
  });

  it('emits a paused budget_exhausted manifest and exits 2', async () => {
    const dir = path.join(os.tmpdir(), `bird-capture-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    vi.spyOn(TwitterClient.prototype, 'captureLikesPage').mockImplementation(async (options) => {
      const info = {
        operation: 'Likes' as const,
        queryId: 'qid',
        method: 'GET' as const,
        variables: {},
        attemptIndex: 1,
      };
      expect(await options.beforeAttempt?.(info)).toEqual({ action: 'proceed' });
      const exhausted = await options.beforeAttempt?.(info);
      expect(exhausted).toMatchObject({
        action: 'pause',
        errorKind: 'budget_exhausted',
      });
      return {
        outcome: 'paused',
        error: exhausted && 'error' in exhausted ? exhausted.error : 'Attempt budget exhausted',
        errorKind: 'budget_exhausted',
        attemptCount: 1,
      } satisfies PageResult;
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
      logs.push(String(message));
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      parseCapture([
        'capture-page',
        'likes',
        '--user-id',
        '1',
        '--capture-dir',
        dir,
        '--request-id',
        'task-budget',
        '--max-attempts',
        '1',
        '--min-delay-ms',
        '0',
      ]),
    ).rejects.toThrow('exit 2');

    const manifest = JSON.parse(logs[0] ?? '') as { outcome: string; errorKind?: string };
    expect(manifest.outcome).toBe('paused');
    expect(manifest.errorKind).toBe('budget_exhausted');
    exitSpy.mockRestore();
  });

  it('stops after a persistence failure and does not retry', async () => {
    const dir = path.join(os.tmpdir(), `bird-capture-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    const first = capturedResponse({ attemptId: 'aaaaaaa1-1111-4111-8111-111111111111' });
    await writeFile(path.join(dir, `capture-${first.attemptId}.json`), '{}');

    let persistCalls = 0;
    vi.spyOn(TwitterClient.prototype, 'captureLikesPage').mockImplementation(async (options) => {
      try {
        persistCalls += 1;
        if (options.onResponse) {
          await options.onResponse(first);
        }
        persistCalls += 1;
        if (options.onResponse) {
          await options.onResponse(capturedResponse({ attemptId: 'bbbbbbb2-2222-4222-8222-222222222222' }));
        }
        return { outcome: 'ok', response: first, attemptCount: 1 } satisfies PageResult;
      } catch (error) {
        return {
          outcome: 'error',
          error: error instanceof Error ? error.message : String(error),
          errorKind: 'persistence_failed',
          attemptCount: 1,
        } satisfies PageResult;
      }
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
      logs.push(String(message));
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      parseCapture([
        'capture-page',
        'likes',
        '--user-id',
        '1',
        '--capture-dir',
        dir,
        '--request-id',
        'task-exist',
        '--min-delay-ms',
        '0',
      ]),
    ).rejects.toThrow('exit 1');

    expect(persistCalls).toBe(1);
    const manifest = JSON.parse(logs[0] ?? '') as {
      outcome: string;
      errorKind?: string;
      responses: string[];
      attemptCount?: number;
    };
    expect(manifest.outcome).toBe('error');
    expect(manifest.errorKind).toBe('persistence_failed');
    expect(manifest.responses).toEqual([]);
    expect(manifest.attemptCount).toBe(1);
    exitSpy.mockRestore();
  });

  it('pauses on unread 429 without writing a capture file', async () => {
    const dir = path.join(os.tmpdir(), `bird-capture-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    const originalFetch = global.fetch;
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: new Headers({ 'retry-after': '60' }),
      text: async () => {
        throw new Error('body closed');
      },
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
      logs.push(String(message));
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(
        parseCapture([
          'capture-page',
          'likes',
          '--user-id',
          '1',
          '--capture-dir',
          dir,
          '--request-id',
          'task-429-text',
          '--min-delay-ms',
          '0',
        ]),
      ).rejects.toThrow('exit 2');

      const manifest = JSON.parse(logs[0] ?? '') as {
        outcome: string;
        errorKind?: string;
        responses: string[];
        attemptCount: number;
        finalResponse?: string;
        retryAt?: string;
      };
      expect(manifest.outcome).toBe('paused');
      expect(manifest.errorKind).toBe('rate_limited');
      expect(manifest.responses).toEqual([]);
      expect(manifest.finalResponse).toBeUndefined();
      expect(manifest.attemptCount).toBe(1);
      expect(Date.parse(manifest.retryAt ?? '')).toBeGreaterThan(Date.now());
      expect(await readdir(dir)).toEqual([]);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    } finally {
      global.fetch = originalFetch;
      exitSpy.mockRestore();
    }
  });

  it('reports attemptCount 1 with zero responses when transport fails before a body', async () => {
    const dir = path.join(os.tmpdir(), `bird-capture-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    vi.spyOn(TwitterClient.prototype, 'captureLikesPage').mockResolvedValue({
      outcome: 'error',
      error: 'socket down',
      errorKind: 'network_error',
      attemptCount: 1,
    } satisfies PageResult);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
      logs.push(String(message));
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      parseCapture([
        'capture-page',
        'likes',
        '--user-id',
        '1',
        '--capture-dir',
        dir,
        '--request-id',
        'task-net',
        '--min-delay-ms',
        '0',
      ]),
    ).rejects.toThrow('exit 1');

    const manifest = JSON.parse(logs[0] ?? '') as {
      outcome: string;
      responses: string[];
      attemptCount: number;
      finalResponse?: string;
    };
    expect(manifest.outcome).toBe('error');
    expect(manifest.responses).toEqual([]);
    expect(manifest.attemptCount).toBe(1);
    expect(manifest.finalResponse).toBeUndefined();
    expect(await readdir(dir)).toEqual([]);
    exitSpy.mockRestore();
  });

  it('rejects invalid operation, count, delay, not-before, and missing credentials', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      parseCapture(['capture-page', 'other', '--capture-dir', '/tmp', '--request-id', 'ok']),
    ).rejects.toThrow('exit 1');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('likes" or "detail'));

    await expect(
      parseCapture([
        'capture-page',
        'likes',
        '--user-id',
        '1',
        '--capture-dir',
        '/tmp',
        '--request-id',
        'ok',
        '--count',
        '21',
      ]),
    ).rejects.toThrow('exit 1');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--count'));

    await expect(
      parseCapture([
        'capture-page',
        'likes',
        '--user-id',
        '1',
        '--capture-dir',
        '/tmp',
        '--request-id',
        'ok',
        '--min-delay-ms',
        '-1',
      ]),
    ).rejects.toThrow('exit 1');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--min-delay-ms'));

    await expect(
      parseCapture([
        'capture-page',
        'likes',
        '--user-id',
        '1',
        '--capture-dir',
        '/tmp',
        '--request-id',
        'ok',
        '--not-before',
        'yesterday',
      ]),
    ).rejects.toThrow('exit 1');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--not-before'));

    const noCreds = {
      ...baseCtx,
      resolveCredentialsFromOptions: async () => ({
        cookies: { authToken: '', ct0: '' },
        warnings: ['cookie warning'],
      }),
    } as unknown as CliContext;
    await expect(
      parseCapture(['capture-page', 'likes', '--user-id', '1', '--capture-dir', '/tmp', '--request-id', 'ok'], noCreds),
    ).rejects.toThrow('exit 1');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Missing required credentials'));

    exitSpy.mockRestore();
  });

  it('rejects detail without tweet id and invalid attempt budget', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      parseCapture(['capture-page', 'detail', '--capture-dir', '/tmp', '--request-id', 'ok']),
    ).rejects.toThrow('exit 1');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--tweet-id is required'));

    await expect(
      parseCapture([
        'capture-page',
        'likes',
        '--user-id',
        '1',
        '--capture-dir',
        '/tmp',
        '--request-id',
        'ok',
        '--max-attempts',
        '0',
      ]),
    ).rejects.toThrow('exit 1');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--max-attempts'));

    exitSpy.mockRestore();
  });
});
