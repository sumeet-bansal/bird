import type { Command } from 'commander';
import type { CliContext } from '../cli/shared.js';
import { CaptureAttemptGate } from '../lib/capture-gate.js';
import { persistCapturedResponse } from '../lib/capture-persist.js';
import { TwitterClient } from '../lib/twitter-client.js';
import {
  CAPTURE_SCHEMA_VERSION,
  type CapturedResponse,
  type CaptureManifest,
  type CaptureOperation,
} from '../lib/twitter-client-page-request.js';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const REQUEST_ID_MAX_LENGTH = 128;

type CapturePageCommandOptions = {
  captureDir?: string;
  requestId?: string;
  userId?: string;
  tweetId?: string;
  count?: string;
  cursor?: string;
  maxAttempts?: string;
  minDelayMs?: string;
  notBefore?: string;
};

export function parseRequestId(value: string): { ok: true; value: string } | { ok: false; error: string } {
  if (!value || !REQUEST_ID_PATTERN.test(value) || value.length > REQUEST_ID_MAX_LENGTH) {
    return {
      ok: false,
      error: `Invalid --request-id. Expected a filename-safe token of 1-${REQUEST_ID_MAX_LENGTH} characters [A-Za-z0-9._-].`,
    };
  }
  return { ok: true, value };
}

const WHOLE_INTEGER_PATTERN = /^-?\d+$/;
const STRICT_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseWholeInteger(value: string): number | undefined {
  if (!WHOLE_INTEGER_PATTERN.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return undefined;
  }
  return parsed;
}

export function parsePositiveInteger(
  value: string | undefined,
  name: string,
  fallback: number,
): { ok: true; value: number } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, value: fallback };
  }
  const raw = parseWholeInteger(value);
  if (raw === undefined || raw <= 0) {
    return { ok: false, error: `Invalid ${name}. Expected a positive integer.` };
  }
  return { ok: true, value: raw };
}

export function parseNonNegativeInteger(
  value: string | undefined,
  name: string,
  fallback: number,
): { ok: true; value: number } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, value: fallback };
  }
  const raw = parseWholeInteger(value);
  if (raw === undefined || raw < 0) {
    return { ok: false, error: `Invalid ${name}. Expected a non-negative integer.` };
  }
  return { ok: true, value: raw };
}

export function parseCount(value: string | undefined): { ok: true; value: number } | { ok: false; error: string } {
  const parsed = parsePositiveInteger(value, '--count', 20);
  if (!parsed.ok) {
    return parsed;
  }
  if (parsed.value > 20) {
    return { ok: false, error: 'Invalid --count. Expected an integer from 1 to 20.' };
  }
  return parsed;
}

export function parseIsoTime(value: string | undefined): { ok: true; value?: Date } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!STRICT_ISO_PATTERN.test(value)) {
    return { ok: false, error: 'Invalid --not-before. Expected a valid ISO-8601 timestamp.' };
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { ok: false, error: 'Invalid --not-before. Expected a valid ISO-8601 timestamp.' };
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) {
    return { ok: false, error: 'Invalid --not-before. Expected a valid ISO-8601 timestamp.' };
  }
  return { ok: true, value: date };
}

export function parseCaptureOperation(
  operation: string,
): { ok: true; value: CaptureOperation } | { ok: false; error: string } {
  if (operation === 'likes') {
    return { ok: true, value: 'Likes' };
  }
  if (operation === 'detail') {
    return { ok: true, value: 'TweetDetail' };
  }
  return { ok: false, error: 'Invalid operation. Expected "likes" or "detail".' };
}

function emitManifest(manifest: CaptureManifest): void {
  console.log(JSON.stringify(manifest));
}

function exitForOutcome(outcome: 'ok' | 'paused' | 'error'): void {
  if (outcome === 'ok') {
    return;
  }
  process.exit(outcome === 'paused' ? 2 : 1);
}

export function registerCapturePageCommand(program: Command, ctx: CliContext): void {
  program
    .command('capture-page')
    .description('Capture one raw Likes or TweetDetail GraphQL page into a capture directory')
    .argument('<operation>', 'likes or detail')
    .requiredOption('--capture-dir <dir>', 'Directory for append-only capture-<attemptId>.json files')
    .requiredOption('--request-id <id>', 'Filename-safe request/task id')
    .option('--user-id <id>', 'User ID for likes (required for likes; avoids hidden current-user lookup)')
    .option('--tweet-id <id>', 'Tweet ID for detail')
    .option('--count <number>', 'Likes page size (1-20)', '20')
    .option('--cursor <cursor>', 'Opaque pagination cursor')
    .option('--max-attempts <number>', 'Selected-endpoint attempt budget', '3')
    .option('--min-delay-ms <number>', 'Minimum delay between selected-endpoint attempts', '2500')
    .option('--not-before <iso>', 'Initial endpoint eligibility time (ISO-8601)')
    .action(async (operationArg: string, cmdOpts: CapturePageCommandOptions) => {
      const operationParsed = parseCaptureOperation(operationArg);
      if (!operationParsed.ok) {
        console.error(`${ctx.p('err')}${operationParsed.error}`);
        process.exit(1);
      }
      const operation = operationParsed.value;

      const requestIdParsed = parseRequestId(cmdOpts.requestId ?? '');
      if (!requestIdParsed.ok) {
        console.error(`${ctx.p('err')}${requestIdParsed.error}`);
        process.exit(1);
      }
      const requestId = requestIdParsed.value;

      const captureDir = cmdOpts.captureDir;
      if (!captureDir) {
        console.error(`${ctx.p('err')}--capture-dir is required.`);
        process.exit(1);
      }

      const maxAttempts = parsePositiveInteger(cmdOpts.maxAttempts, '--max-attempts', 3);
      if (!maxAttempts.ok) {
        console.error(`${ctx.p('err')}${maxAttempts.error}`);
        process.exit(1);
      }
      const minDelayMs = parseNonNegativeInteger(cmdOpts.minDelayMs, '--min-delay-ms', 2500);
      if (!minDelayMs.ok) {
        console.error(`${ctx.p('err')}${minDelayMs.error}`);
        process.exit(1);
      }
      const notBefore = parseIsoTime(cmdOpts.notBefore);
      if (!notBefore.ok) {
        console.error(`${ctx.p('err')}${notBefore.error}`);
        process.exit(1);
      }

      if (operation === 'Likes' && !cmdOpts.userId) {
        console.error(`${ctx.p('err')}--user-id is required for likes.`);
        process.exit(1);
      }
      if (operation === 'TweetDetail' && !cmdOpts.tweetId) {
        console.error(`${ctx.p('err')}--tweet-id is required for detail.`);
        process.exit(1);
      }

      const count = parseCount(cmdOpts.count);
      if (operation === 'Likes' && !count.ok) {
        console.error(`${ctx.p('err')}${count.error}`);
        process.exit(1);
      }

      const opts = program.opts();
      const timeoutMs = ctx.resolveTimeoutFromOptions(opts);
      const quoteDepth = ctx.resolveQuoteDepthFromOptions(opts);
      const { cookies, warnings } = await ctx.resolveCredentialsFromOptions(opts);
      for (const warning of warnings) {
        console.error(`${ctx.p('warn')}${warning}`);
      }
      if (!cookies.authToken || !cookies.ct0) {
        console.error(`${ctx.p('err')}Missing required credentials`);
        process.exit(1);
      }

      const installed: string[] = [];
      const gate = new CaptureAttemptGate({
        maxAttempts: maxAttempts.value,
        minDelayMs: minDelayMs.value,
        notBefore: notBefore.value,
      });

      const onResponse = async (response: CapturedResponse): Promise<void> => {
        const filename = await persistCapturedResponse(captureDir, response);
        installed.push(filename);
        gate.observeResponse(response);
      };

      const client = new TwitterClient({ cookies, timeoutMs, quoteDepth });
      const result =
        operation === 'Likes'
          ? await client.captureLikesPage({
              requestId,
              userId: cmdOpts.userId,
              count: count.ok ? count.value : 20,
              cursor: cmdOpts.cursor,
              beforeAttempt: gate.beforeAttempt,
              onResponse,
            })
          : await client.captureTweetDetailPage({
              requestId,
              tweetId: cmdOpts.tweetId ?? '',
              cursor: cmdOpts.cursor,
              beforeAttempt: gate.beforeAttempt,
              onResponse,
            });

      const finalResponse = result.response ? `capture-${result.response.attemptId}.json` : undefined;
      const manifest: CaptureManifest = {
        schemaVersion: CAPTURE_SCHEMA_VERSION,
        requestId,
        operation,
        outcome: result.outcome,
        responses: installed,
        attemptCount: result.attemptCount,
        ...(finalResponse && installed.includes(finalResponse) ? { finalResponse } : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.errorKind ? { errorKind: result.errorKind } : {}),
        ...(result.retryAt ? { retryAt: result.retryAt } : {}),
      };

      if (result.outcome !== 'ok') {
        console.error(
          `${ctx.p(result.outcome === 'paused' ? 'warn' : 'err')}capture-page ${result.outcome}${
            result.error ? `: ${result.error}` : ''
          }`,
        );
      }

      emitManifest(manifest);
      exitForOutcome(result.outcome);
    });
}
