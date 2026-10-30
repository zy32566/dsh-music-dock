#!/usr/bin/env node
/**
 * Make `@doitian/dsh-music`'s search work again, and make it fail loudly.
 *
 * ## The failure
 *
 * Search calls the legacy endpoint `GET /api/search/get/web` **with the
 * account cookie**. NetEase now answers that combination with
 *
 *     {"msg":"操作频繁，请稍候再试","code":405}
 *
 * for this account — a rate limit/block that persisted for days, not a burst.
 * The same request *without* the cookie answers normally (273 results for
 * 周杰伦, reproduced repeatedly), and so does the newer
 * `POST /api/cloudsearch/pc` — but that one returns the new field names
 * (`ar`/`al`/`dt`/`mv`) which the host's normalizer does not read, so switching
 * endpoints would mean rewriting the mapping too.
 *
 * Search results are public data; the cookie buys nothing here. So this patch
 * sends the search calls with an empty cookie, which is the smallest change
 * that restores the feature.
 *
 * ## The second half: stop reporting a block as "nothing found"
 *
 * `searchSongs` reads `result.songCount ?? 0` and ignores `code` entirely, so a
 * 405 became a legitimate-looking "0 results" — which is why the UI said
 * nothing instead of explaining itself. This patch throws on a non-200 code so
 * the reason reaches the player.
 *
 * ## It is a patch, and patches are lost
 *
 * Re-run after `dsh plugin add @doitian/dsh-music`.
 *
 *   node patches/fix-search-rate-limit.mjs
 *   node patches/fix-search-rate-limit.mjs --check
 */

import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROFILE = process.env.DSH_PROFILE ?? 'desktop';
const NET = join(
  homedir(),
  '.dsh',
  'profiles',
  PROFILE,
  'node_modules',
  '@doitian',
  'dsh-music',
  'lib',
  'netease.js',
);

/** Present when the patch is already applied. */
const MARKER = 'dsh-music-dock patch: search without the account cookie';

const ANCHOR_SONGS = `    const data = await this.call('/api/search/get/web', {
      query: { csrf_token: '', s: keyword, type: 1, offset, limit },
    });
    const result = data?.result ?? {};
    return {
      total: result.songCount ?? 0,
      tracks: normalizeTracks(result.songs),
    };`;

const ANCHOR_ALL = `    const data = await this.call('/api/search/get/web', {
      query: { csrf_token: '', s: keyword, type, offset, limit },
    });
    return data?.result ?? {};`;

/** Shared once, so the reason is written down in exactly one place. */
const COOKIE_NOTE = `      // ${MARKER}:
      // a signed-in call to this legacy endpoint answers {"code":405,
      // "msg":"操作频繁"} for this account. Results are public, so send no
      // cookie. See patches/fix-search-rate-limit.mjs.
      headers: { Cookie: '' },`;

const REPL_SONGS = `    const data = await this.call('/api/search/get/web', {
      query: { csrf_token: '', s: keyword, type: 1, offset, limit },
${COOKIE_NOTE}
    });
    // A blocked search must not look like an empty catalogue.
    if (data?.code !== 200) {
      throw new NeteaseError(\`search failed: \${data?.msg ?? data?.message ?? data?.code}\`, {
        code: 'SEARCH',
        endpoint: '/api/search/get/web',
      });
    }
    const result = data?.result ?? {};
    return {
      total: result.songCount ?? 0,
      tracks: normalizeTracks(result.songs),
    };`;

const REPL_ALL = `    const data = await this.call('/api/search/get/web', {
      query: { csrf_token: '', s: keyword, type, offset, limit },
${COOKIE_NOTE}
    });
    if (data?.code !== 200) {
      throw new NeteaseError(\`search failed: \${data?.msg ?? data?.message ?? data?.code}\`, {
        code: 'SEARCH',
        endpoint: '/api/search/get/web',
      });
    }
    return data?.result ?? {};`;

const checkOnly = process.argv.includes('--check');

let source;
try {
  source = await readFile(NET, 'utf8');
} catch (error) {
  console.error(`cannot read ${NET}: ${error.message}`);
  console.error('Is @doitian/dsh-music installed in that profile? Set DSH_PROFILE to override.');
  process.exit(1);
}

if (source.includes(MARKER)) {
  console.log(`already patched: ${NET}`);
  process.exit(0);
}

const missing = [];
if (!source.includes(ANCHOR_SONGS)) missing.push('searchSongs');
if (!source.includes(ANCHOR_ALL)) missing.push('search');
if (missing.length > 0) {
  console.error(`anchor not found for: ${missing.join(', ')} — the upstream file changed shape.`);
  console.error(`edit ${NET} by hand: send the /api/search/get/web calls with an empty Cookie,`);
  console.error('and throw on a non-200 `code` instead of returning zero results.');
  process.exit(2);
}

if (checkOnly) {
  console.log(`not patched: ${NET}`);
  process.exit(1);
}

const patched = source.replace(ANCHOR_SONGS, REPL_SONGS).replace(ANCHOR_ALL, REPL_ALL);
await writeFile(NET, patched, 'utf8');
console.log(`patched: ${NET}`);
console.log('restart the harness so the host module is reloaded.');
