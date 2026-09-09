import { describe, expect, it, vi } from 'vitest';
import { CaptureAttemptGate } from '../src/lib/capture-gate.js';
import type { CapturedResponse } from '../src/lib/twitter-client-page-request.js';

function response(headers: Record<string, string>, status = 200): CapturedResponse {
  return {
    schemaVersion: 1,
    requestId: 'r',
    attemptId: 'a',
    operation: 'Likes',
    queryId: 'q',
    method: 'GET',
    variables: {},
    fetchedAt: '2026-09-08T18:00:00.000Z',
    status,
    headers,
    body: '',
  };
}

describe('CaptureAttemptGate', () => {
  it('pauses when the initial not-before is far in the future', async () => {
    const gate = new CaptureAttemptGate({
      maxAttempts: 3,
      minDelayMs: 2500,
      notBefore: new Date('2026-09-08T21:00:00.000Z'),
      now: () => Date.parse('2026-09-08T20:00:00.000Z'),
      sleep: async () => {
        throw new Error('should not sleep for a long not-before');
      },
    });

    await expect(
      gate.beforeAttempt({
        operation: 'Likes',
        queryId: 'q',
        method: 'GET',
        variables: {},
        attemptIndex: 1,
      }),
    ).resolves.toEqual({
      action: 'pause',
      retryAt: '2026-09-08T21:00:00.000Z',
      error: 'Endpoint is not eligible yet',
      errorKind: 'not_before',
    });
  });

  it('sleeps for the normal minimum delay between attempts', async () => {
    const sleeps: number[] = [];
    let now = 1_000;
    const gate = new CaptureAttemptGate({
      maxAttempts: 3,
      minDelayMs: 2500,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });

    await expect(
      gate.beforeAttempt({
        operation: 'Likes',
        queryId: 'q',
        method: 'GET',
        variables: {},
        attemptIndex: 1,
      }),
    ).resolves.toEqual({ action: 'proceed' });

    const second = gate.beforeAttempt({
      operation: 'Likes',
      queryId: 'q',
      method: 'GET',
      variables: {},
      attemptIndex: 2,
    });
    await expect(second).resolves.toEqual({ action: 'proceed' });
    expect(sleeps).toEqual([2500]);
  });

  it('returns budget_exhausted without proceeding once the budget is used', async () => {
    const gate = new CaptureAttemptGate({
      maxAttempts: 1,
      minDelayMs: 0,
      now: () => 0,
      sleep: async () => undefined,
    });
    const info = {
      operation: 'TweetDetail' as const,
      queryId: 'q',
      method: 'GET' as const,
      variables: {},
      attemptIndex: 1,
    };
    expect(await gate.beforeAttempt(info)).toEqual({ action: 'proceed' });
    expect(await gate.beforeAttempt(info)).toEqual({
      action: 'pause',
      error: 'Attempt budget exhausted',
      errorKind: 'budget_exhausted',
    });
  });

  it('gates a later repair when quota remaining is zero', async () => {
    const reset = Math.floor(Date.parse('2026-09-08T22:00:00.000Z') / 1000);
    const now = Date.parse('2026-09-08T20:00:00.000Z');
    const gate = new CaptureAttemptGate({
      maxAttempts: 3,
      minDelayMs: 2500,
      now: () => now,
      sleep: async () => {
        throw new Error('should pause rather than sleep for quota reset');
      },
    });

    expect(
      await gate.beforeAttempt({
        operation: 'Likes',
        queryId: 'q',
        method: 'GET',
        variables: {},
        attemptIndex: 1,
      }),
    ).toEqual({ action: 'proceed' });

    gate.observeResponse(
      response({
        'x-rate-limit-remaining': '0',
        'x-rate-limit-reset': String(reset),
      }),
    );

    expect(
      await gate.beforeAttempt({
        operation: 'Likes',
        queryId: 'q',
        method: 'GET',
        variables: {},
        attemptIndex: 2,
      }),
    ).toEqual({
      action: 'pause',
      retryAt: '2026-09-08T22:00:00.000Z',
      error: 'Endpoint is not eligible yet',
      errorKind: 'quota_exhausted',
    });
  });

  it('uses a conservative future pause when remaining is zero and reset is past or invalid', async () => {
    const now = Date.parse('2026-09-08T20:00:00.000Z');
    const gate = new CaptureAttemptGate({
      maxAttempts: 3,
      minDelayMs: 2500,
      now: () => now,
      sleep: async () => {
        throw new Error('should pause rather than sleep for invalid reset');
      },
    });

    expect(
      await gate.beforeAttempt({
        operation: 'Likes',
        queryId: 'q',
        method: 'GET',
        variables: {},
        attemptIndex: 1,
      }),
    ).toEqual({ action: 'proceed' });

    gate.observeResponse(
      response({
        'x-rate-limit-remaining': '0',
        'x-rate-limit-reset': '20abc',
      }),
    );

    const decision = await gate.beforeAttempt({
      operation: 'Likes',
      queryId: 'q',
      method: 'GET',
      variables: {},
      attemptIndex: 2,
    });
    expect(decision.action).toBe('pause');
    expect(decision.errorKind).toBe('quota_exhausted');
    expect(decision.retryAt).toBe(new Date(now + 60_000).toISOString());
  });

  it('updates eligibility from a 429 Retry-After', async () => {
    const gate = new CaptureAttemptGate({
      maxAttempts: 3,
      minDelayMs: 100,
      now: () => Date.parse('2026-09-08T20:00:00.000Z'),
      sleep: async () => {
        throw new Error('should pause');
      },
    });
    await gate.beforeAttempt({
      operation: 'Likes',
      queryId: 'q',
      method: 'GET',
      variables: {},
      attemptIndex: 1,
    });
    gate.observeResponse(response({ 'retry-after': '90' }, 429));
    const decision = await gate.beforeAttempt({
      operation: 'Likes',
      queryId: 'q',
      method: 'GET',
      variables: {},
      attemptIndex: 2,
    });
    expect(decision.action).toBe('pause');
    expect(decision.errorKind).toBe('rate_limited');
  });

  it('uses conservative future eligibility when remaining is zero and reset/retry are missing', async () => {
    const now = Date.parse('2026-09-08T20:00:00.000Z');
    const gate = new CaptureAttemptGate({
      maxAttempts: 3,
      minDelayMs: 2500,
      now: () => now,
      sleep: async () => {
        throw new Error('should pause rather than sleep when reset is missing');
      },
    });
    expect(
      await gate.beforeAttempt({
        operation: 'Likes',
        queryId: 'q',
        method: 'GET',
        variables: {},
        attemptIndex: 1,
      }),
    ).toEqual({ action: 'proceed' });

    gate.observeResponse(response({ 'x-rate-limit-remaining': '0' }));

    expect(
      await gate.beforeAttempt({
        operation: 'Likes',
        queryId: 'q',
        method: 'GET',
        variables: {},
        attemptIndex: 2,
      }),
    ).toEqual({
      action: 'pause',
      retryAt: new Date(now + 60_000).toISOString(),
      error: 'Endpoint is not eligible yet',
      errorKind: 'quota_exhausted',
    });
  });

  it('keeps a known future retryAt on budget exhaustion', async () => {
    const now = Date.parse('2026-09-08T20:00:00.000Z');
    const gate = new CaptureAttemptGate({
      maxAttempts: 1,
      minDelayMs: 0,
      now: () => now,
      sleep: async () => undefined,
    });
    const info = {
      operation: 'Likes' as const,
      queryId: 'q',
      method: 'GET' as const,
      variables: {},
      attemptIndex: 1,
    };
    expect(await gate.beforeAttempt(info)).toEqual({ action: 'proceed' });
    gate.observeResponse(
      response({
        'x-rate-limit-remaining': '0',
        'x-rate-limit-reset': String(Math.floor(Date.parse('2026-09-08T22:00:00.000Z') / 1000)),
      }),
    );
    expect(await gate.beforeAttempt(info)).toEqual({
      action: 'pause',
      error: 'Attempt budget exhausted',
      errorKind: 'budget_exhausted',
      retryAt: '2026-09-08T22:00:00.000Z',
    });
  });
});

describe('CaptureAttemptGate sleep path', () => {
  it('sleeps when not-before is within the minimum delay window', async () => {
    const sleep = vi.fn(async () => undefined);
    const gate = new CaptureAttemptGate({
      maxAttempts: 1,
      minDelayMs: 2500,
      notBefore: new Date('2026-09-08T20:00:01.000Z'),
      now: () => Date.parse('2026-09-08T20:00:00.000Z'),
      sleep,
    });
    expect(
      await gate.beforeAttempt({
        operation: 'Likes',
        queryId: 'q',
        method: 'GET',
        variables: {},
        attemptIndex: 1,
      }),
    ).toEqual({ action: 'proceed' });
    expect(sleep).toHaveBeenCalledWith(1000);
  });
});
