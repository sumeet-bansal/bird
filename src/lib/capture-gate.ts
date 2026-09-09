import type { BeforeAttemptDecision, BeforeAttemptGate, CapturedResponse } from './twitter-client-page-request.js';
import { parseRetryAt } from './twitter-client-page-request.js';

export type CaptureGateOptions = {
  maxAttempts: number;
  minDelayMs: number;
  notBefore?: Date;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class CaptureAttemptGate {
  private attemptCount = 0;
  private lastAttemptAt: number | undefined;
  private notBefore: Date | undefined;
  private notBeforeKind: string | undefined;
  private readonly maxAttempts: number;
  private readonly minDelayMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: CaptureGateOptions) {
    this.maxAttempts = options.maxAttempts;
    this.minDelayMs = options.minDelayMs;
    this.notBefore = options.notBefore;
    this.notBeforeKind = options.notBefore ? 'not_before' : undefined;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  observeResponse(response: CapturedResponse): void {
    const remaining = response.headers['x-rate-limit-remaining'];
    const retryAt = parseRetryAt(response.headers, this.now());
    if (response.status === 429) {
      this.notBefore = retryAt ?? new Date(this.now() + 60_000);
      this.notBeforeKind = 'rate_limited';
      return;
    }
    if (remaining === '0') {
      this.notBefore = retryAt ?? new Date(this.now() + 60_000);
      this.notBeforeKind = 'quota_exhausted';
    }
  }

  beforeAttempt: BeforeAttemptGate = async (): Promise<BeforeAttemptDecision> => {
    if (this.attemptCount >= this.maxAttempts) {
      const retryAt =
        this.notBefore && this.notBefore.getTime() > this.now() ? this.notBefore.toISOString() : undefined;
      return {
        action: 'pause',
        error: 'Attempt budget exhausted',
        errorKind: 'budget_exhausted',
        ...(retryAt ? { retryAt } : {}),
      };
    }

    const now = this.now();
    if (this.notBefore && this.notBefore.getTime() > now) {
      const waitMs = this.notBefore.getTime() - now;
      if (waitMs > this.minDelayMs) {
        return {
          action: 'pause',
          retryAt: this.notBefore.toISOString(),
          error: 'Endpoint is not eligible yet',
          errorKind: this.notBeforeKind ?? 'not_before',
        };
      }
      await this.sleep(waitMs);
    }

    if (this.lastAttemptAt !== undefined) {
      const elapsed = now - this.lastAttemptAt;
      if (elapsed < this.minDelayMs) {
        await this.sleep(this.minDelayMs - elapsed);
      }
    }

    this.attemptCount += 1;
    this.lastAttemptAt = this.now();
    return { action: 'proceed' };
  };
}
