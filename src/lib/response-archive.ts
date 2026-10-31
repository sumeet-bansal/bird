import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

/** DMs are other people's private messages; account pages hold the owner's settings. */
const NOT_ARCHIVED = /\/dm\/|\/account\/|\/settings\b/;
const RATE_LIMIT_HEADERS = ['x-rate-limit-limit', 'x-rate-limit-remaining', 'x-rate-limit-reset'];

export type ArchivedResponse = {
  archivedAt: string;
  method: string;
  url: string;
  status: number;
  rateLimit: Record<string, string>;
  body: string;
};

export function archiveDir(): string | null {
  const configured = process.env.BIRD_ARCHIVE_DIR;
  if (configured === 'off') {
    return null;
  }
  if (configured) {
    return configured;
  }
  return process.env.NODE_ENV === 'test' ? null : path.join(homedir(), '.local', 'share', 'bird', 'archive');
}

/** The last path segment: the GraphQL operation name, or the REST resource. */
function operationOf(url: string): string {
  const name = new URL(url).pathname.split('/').at(-1) ?? 'response';
  return name.replace(/[^a-zA-Z0-9]+/g, '-') || 'response';
}

function writeEntry(dir: string, entry: ArchivedResponse): void {
  const day = entry.archivedAt.slice(0, 10).replaceAll('-', '/');
  const stamp = entry.archivedAt.replaceAll(/[:.]/g, '-');
  const dayDir = path.join(dir, day);
  const name = `${stamp}-${operationOf(entry.url)}-${randomUUID().slice(0, 8)}.json.gz`;
  const tmp = path.join(dayDir, `.${name}.tmp`);
  mkdirSync(dayDir, { recursive: true });
  writeFileSync(tmp, gzipSync(JSON.stringify(entry)));
  try {
    renameSync(tmp, path.join(dayDir, name));
  } catch (error) {
    unlinkSync(tmp);
    throw error;
  }
}

/**
 * Saves one response as its own gzip file, so concurrent bird processes never share a write
 * and a crash leaves no partial entry. Request headers are never stored, so cookies can't reach
 * the archive. Saving is best-effort: a failure here must never fail the read that caused it.
 */
export async function archiveResponse(url: string, init: RequestInit, response: Response): Promise<void> {
  const dir = archiveDir();
  if (!dir || NOT_ARCHIVED.test(url)) {
    return;
  }
  try {
    const rateLimit = Object.fromEntries(
      RATE_LIMIT_HEADERS.flatMap((name) => {
        const value = response.headers.get(name);
        return value ? [[name, value]] : [];
      }),
    );
    writeEntry(dir, {
      archivedAt: new Date().toISOString(),
      method: init.method ?? 'GET',
      url,
      status: response.status,
      rateLimit,
      body: await response.clone().text(),
    });
  } catch (error) {
    console.error(`bird: response not archived: ${String(error)}`);
  }
}
