import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { CapturedResponse } from './twitter-client-page-request.js';

function fsyncDirectory(dirPath: string): void {
  const fd = openSync(dirPath, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function collectAbsentDirectories(dirPath: string): string[] {
  const absent: string[] = [];
  let current = dirPath;
  while (!existsSync(current)) {
    absent.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return absent;
}

function fsyncNewDirectoryEntries(createdDirs: string[]): void {
  for (const created of createdDirs) {
    fsyncDirectory(path.dirname(created));
  }
}

export function captureFilename(attemptId: string): string {
  return `capture-${attemptId}.json`;
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === 'EEXIST',
  );
}

export async function persistCapturedResponse(captureDir: string, response: CapturedResponse): Promise<string> {
  const resolvedDir = path.resolve(captureDir);
  const createdDirs = collectAbsentDirectories(resolvedDir);
  await mkdir(resolvedDir, { recursive: true });
  fsyncNewDirectoryEntries(createdDirs);
  const filename = captureFilename(response.attemptId);
  const dest = path.join(resolvedDir, filename);
  const tmp = path.join(resolvedDir, `.capture-${response.attemptId}.${randomUUID()}.tmp`);
  const body = JSON.stringify(response);

  try {
    writeFileSync(tmp, body);
    const fd = openSync(tmp, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(tmp, dest);
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new Error(`Capture file already exists: ${filename}`);
      }
      throw error;
    }
    fsyncDirectory(resolvedDir);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // tmp may not exist if write failed before create
    }
    throw error;
  }

  try {
    unlinkSync(tmp);
  } catch {
    // dest is already installed; leftover tmp is harmless
  }

  return filename;
}
