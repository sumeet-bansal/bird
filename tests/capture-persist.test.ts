import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { persistCapturedResponse } from '../src/lib/capture-persist.js';
import type { CapturedResponse } from '../src/lib/twitter-client-page-request.js';

const persistFs = vi.hoisted(() => ({
  fsyncPaths: [] as string[],
  failFsyncOn: undefined as string | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { resolve } = await import('node:path');
  const fdToPath = new Map<number, string>();
  return {
    ...actual,
    openSync: ((...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      fdToPath.set(fd, resolve(String(args[0])));
      return fd;
    }) as typeof actual.openSync,
    fsyncSync: ((fd: number) => {
      const resolved = fdToPath.get(fd);
      if (resolved) {
        persistFs.fsyncPaths.push(resolved);
        if (persistFs.failFsyncOn === resolved) {
          throw new Error(`fsync failed: ${resolved}`);
        }
      }
      actual.fsyncSync(fd);
    }) as typeof actual.fsyncSync,
    closeSync: ((fd: number) => {
      fdToPath.delete(fd);
      actual.closeSync(fd);
    }) as typeof actual.closeSync,
  };
});

function sample(attemptId: string): CapturedResponse {
  return {
    schemaVersion: 1,
    requestId: 'task',
    attemptId,
    operation: 'TweetDetail',
    queryId: 'qid',
    method: 'GET',
    variables: { focalTweetId: '1' },
    fetchedAt: '2026-09-08T18:00:00.000Z',
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: '{"keep":true}',
  };
}

beforeEach(() => {
  persistFs.fsyncPaths = [];
  persistFs.failFsyncOn = undefined;
});

describe('persistCapturedResponse', () => {
  it('atomically installs a self-describing capture file', async () => {
    const dir = path.join(os.tmpdir(), `bird-persist-${randomUUID()}`);
    const attemptId = '33333333-3333-4333-8333-333333333333';
    const filename = await persistCapturedResponse(dir, sample(attemptId));
    expect(filename).toBe(`capture-${attemptId}.json`);
    const names = await readdir(dir);
    expect(names.every((name) => !name.endsWith('.tmp'))).toBe(true);
    const parsed = JSON.parse(await readFile(path.join(dir, filename), 'utf8')) as CapturedResponse;
    expect(parsed.body).toBe('{"keep":true}');
    expect(parsed.attemptId).toBe(attemptId);
  });

  it('refuses to overwrite an existing capture file', async () => {
    const dir = path.join(os.tmpdir(), `bird-persist-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    const attemptId = '44444444-4444-4444-8444-444444444444';
    await writeFile(path.join(dir, `capture-${attemptId}.json`), 'old');
    await expect(persistCapturedResponse(dir, sample(attemptId))).rejects.toThrow('already exists');
    expect(await readFile(path.join(dir, `capture-${attemptId}.json`), 'utf8')).toBe('old');
  });

  it('publishes into a newly created nested capture directory', async () => {
    const parent = path.join(os.tmpdir(), `bird-persist-parent-${randomUUID()}`);
    const dir = path.join(parent, 'captures');
    const attemptId = '66666666-6666-4666-8666-666666666666';
    const filename = await persistCapturedResponse(dir, sample(attemptId));
    const parsed = JSON.parse(await readFile(path.join(dir, filename), 'utf8')) as CapturedResponse;
    expect(parsed.body).toBe('{"keep":true}');
  });

  it('fsyncs every newly created ancestor before acknowledging publish', async () => {
    const existing = path.join(os.tmpdir(), `bird-persist-root-${randomUUID()}`);
    await mkdir(existing, { recursive: true });
    const createdA = path.join(existing, 'a');
    const createdB = path.join(createdA, 'b');
    const captureDir = path.join(createdB, 'captures');
    const attemptId = '77777777-7777-4777-8777-777777777777';

    const filename = await persistCapturedResponse(captureDir, sample(attemptId));
    expect(filename).toBe(`capture-${attemptId}.json`);

    const existingResolved = path.resolve(existing);
    const aResolved = path.resolve(createdA);
    const bResolved = path.resolve(createdB);
    const captureResolved = path.resolve(captureDir);
    const existingIdx = persistFs.fsyncPaths.indexOf(existingResolved);
    const aIdx = persistFs.fsyncPaths.indexOf(aResolved);
    const bIdx = persistFs.fsyncPaths.indexOf(bResolved);
    const captureIdx = persistFs.fsyncPaths.indexOf(captureResolved);
    const tmpIdx = persistFs.fsyncPaths.findIndex((entry) => entry.includes('.capture-') && entry.endsWith('.tmp'));

    expect(bIdx).toBeGreaterThanOrEqual(0);
    expect(aIdx).toBeGreaterThan(bIdx);
    expect(existingIdx).toBeGreaterThan(aIdx);
    expect(tmpIdx).toBeGreaterThan(existingIdx);
    expect(captureIdx).toBeGreaterThan(tmpIdx);
    expect(JSON.parse(await readFile(path.join(captureDir, filename), 'utf8'))).toMatchObject({
      body: '{"keep":true}',
    });
  });

  it('does not acknowledge when an ancestor fsync fails', async () => {
    const existing = path.join(os.tmpdir(), `bird-persist-fail-${randomUUID()}`);
    await mkdir(existing, { recursive: true });
    const captureDir = path.join(existing, 'a', 'b', 'captures');
    persistFs.failFsyncOn = path.resolve(existing);
    await expect(persistCapturedResponse(captureDir, sample('88888888-8888-4888-8888-888888888888'))).rejects.toThrow(
      'fsync failed',
    );
    expect(existsSync(path.join(captureDir, 'capture-88888888-8888-4888-8888-888888888888.json'))).toBe(false);
  });

  it('does not acknowledge when the capture-dir fsync after publish fails', async () => {
    const existing = path.join(os.tmpdir(), `bird-persist-dirfail-${randomUUID()}`);
    await mkdir(existing, { recursive: true });
    const captureDir = path.join(existing, 'captures');
    persistFs.failFsyncOn = path.resolve(captureDir);
    await expect(persistCapturedResponse(captureDir, sample('99999999-9999-4999-8999-999999999999'))).rejects.toThrow(
      'fsync failed',
    );
  });

  it('installs exclusively so a concurrent publish cannot overwrite', async () => {
    const dir = path.join(os.tmpdir(), `bird-persist-${randomUUID()}`);
    const attemptId = '55555555-5555-4555-8555-555555555555';
    const first = persistCapturedResponse(dir, sample(attemptId));
    const second = persistCapturedResponse(dir, {
      ...sample(attemptId),
      body: '{"keep":false}',
    });
    const results = await Promise.allSettled([first, second]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const installed = JSON.parse(await readFile(path.join(dir, `capture-${attemptId}.json`), 'utf8')) as {
      body: string;
    };
    expect(installed.body === '{"keep":true}' || installed.body === '{"keep":false}').toBe(true);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toContain('already exists');
  });
});
