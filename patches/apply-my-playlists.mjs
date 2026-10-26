#!/usr/bin/env node
/**
 * Re-apply the `GET /api/my-playlists` route to `@doitian/dsh-music`.
 *
 * ## Why this exists
 *
 * `@doitian/dsh-music` already implements `userPlaylists(uid)` in
 * `lib/netease.js` — the account's created and collected playlists, with
 * `subscribed` and `specialType: 5` marking 我喜欢的音乐 — but no HTTP route
 * exposes it. Its `/api/playlists` answers `personalizedPlaylists`, i.e. the
 * recommended list, which is not the account's own library.
 *
 * This script adds one route to the installed package so a client plugin can
 * enumerate the account's playlists. The host owns the NetEase session, so the
 * route reuses its auth, cookie and error handling instead of duplicating them.
 *
 * ## It is a patch, and patches are lost
 *
 * `dsh plugin add @doitian/dsh-music` replaces `node_modules`, which reverts
 * this file. Re-run this script after any upgrade, or when the route 404s.
 *
 *   node ~/code/ai-coding/dsh-music-dock/patches/apply-my-playlists.mjs
 *   node .../apply-my-playlists.mjs --check    # report only, change nothing
 *
 * The script is idempotent and refuses to guess: if the anchor text it inserts
 * after is gone, the upstream file changed shape and it exits non-zero instead
 * of writing something wrong.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROFILE = process.env.DSH_PROFILE ?? 'desktop';
const ROUTER = join(
  homedir(),
  '.dsh',
  'profiles',
  PROFILE,
  'node_modules',
  '@doitian',
  'dsh-music',
  'lib',
  'router.js',
);

/** Present when the patch is already applied. */
const MARKER = '--- BEGIN dsh-music-dock patch';

/** The upstream line this route is inserted after. */
const ANCHOR = `    if (route === '/playlists' && method === 'GET') {
      return sendJson(res, 200, await this.api.personalizedPlaylists(12));
    }
`;

const INSERT = `
    // --- BEGIN dsh-music-dock patch: the account's OWN playlists ---
    // \`userPlaylists(uid)\` (created + collected, with \`subscribed\` and
    // \`specialType: 5\` for 我喜欢的音乐) already exists in netease.js; this route
    // only exposes it so a client plugin can enumerate the account's library.
    // Re-apply with dsh-music-dock/patches/apply-my-playlists.mjs after upgrading
    // @doitian/dsh-music, which replaces this file.
    if (route === '/my-playlists' && method === 'GET') {
      const account = this.api.account;
      if (this.api.authenticated !== true || account === null || account === undefined) {
        return sendJson(res, 401, { error: 'not signed in', code: 'ANONYMOUS' });
      }
      return sendJson(res, 200, await this.api.userPlaylists(account.uid));
    }
    // --- END dsh-music-dock patch ---
`;

const checkOnly = process.argv.includes('--check');

let source;
try {
  source = await readFile(ROUTER, 'utf8');
} catch (error) {
  console.error(`cannot read ${ROUTER}: ${error.message}`);
  console.error('Is @doitian/dsh-music installed in that profile? Set DSH_PROFILE to override.');
  process.exit(1);
}

if (source.includes(MARKER)) {
  console.log(`already patched: ${ROUTER}`);
  process.exit(0);
}

if (!source.includes(ANCHOR)) {
  console.error('anchor not found — the upstream router changed shape, so this patch no longer applies.');
  console.error(`look for the '/playlists' route in ${ROUTER} and add the /my-playlists route by hand.`);
  process.exit(2);
}

if (checkOnly) {
  console.log(`not patched: ${ROUTER}`);
  process.exit(1);
}

await writeFile(ROUTER, source.replace(ANCHOR, ANCHOR + INSERT), 'utf8');
console.log(`patched: ${ROUTER}`);
console.log('restart the harness so the route is mounted (the router loads at boot).');
