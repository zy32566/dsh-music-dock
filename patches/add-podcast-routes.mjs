#!/usr/bin/env node
/**
 * Add podcast (播客 / 电台) routes to `@doitian/dsh-music`.
 *
 * ## Why this is small
 *
 * NetEase models every podcast episode as a **song**: a program carries a
 * `mainSong` object with the same fields a track has (`id`, `name`, `artists`,
 * `album`, `duration`, `fee`). Verified against the live API:
 *
 *     GET /music/stream/3455056090?level=standard
 *     -> HTTP 206  audio/mpeg  ID3…
 *
 * So episodes normalize into the very Track shape the queue, the audio proxy
 * and the panel already speak, and `/stream` plays them unchanged. Podcasts
 * therefore need **listing routes only**; nothing in the playback path is
 * touched.
 *
 * A radio is deliberately *not* a Track — it is a container, not something to
 * play — so it is returned as its own row shape.
 *
 * ## Endpoints added
 *
 *   GET /api/podcasts/subscribed          my subscribed radios
 *   GET /api/podcasts/search?q=           radios matching a keyword
 *   GET /api/podcasts/programs?radioId=   one radio's episodes, as Tracks
 *
 * Search reuses `/api/search/get/web` with `type: 1009`. Unlike the song search
 * (type 1) this endpoint answered normally with the account cookie, so the
 * cookie is kept; the non-200 guard is here anyway, so a future block shows up
 * as an error instead of an empty list.
 *
 * ## It is a patch, and patches are lost
 *
 * Re-run after `dsh plugin add @doitian/dsh-music`.
 *
 *   node patches/add-podcast-routes.mjs
 *   node patches/add-podcast-routes.mjs --check
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
const MARKER = '--- BEGIN dsh-music-dock patch: podcasts ---';

/** Import line, extended to reuse the host's own track normalizer. */
const IMPORT_ANCHOR = `import { DEFAULT_LEVEL, LEVELS, isLevel } from './netease.js';`;
const IMPORT_REPLACEMENT = `import { DEFAULT_LEVEL, LEVELS, isLevel, normalizeTrack } from './netease.js';`;

/** Inserted before the catalogue's `/new` route. */
const ROUTE_ANCHOR = `    if (route === '/new' && method === 'GET') {`;

const ROUTES = `    // ${MARKER}
    // Podcast episodes are songs on NetEase (a program carries \`mainSong\`), so
    // normalizing one yields the Track shape the queue, /stream and the panel
    // already use. Only listing is missing, which is what these routes add.
    // A radio is a container rather than something to play, so it gets its own
    // row shape instead of being stretched into a Track.
    const radioRows = (list) =>
      (list ?? [])
        .map((radio) => ({
          id: radio?.id,
          name: radio?.name ?? '',
          cover: radio?.picUrl ?? radio?.intervenePicUrl ?? null,
          desc: radio?.desc ?? '',
          category: radio?.category ?? '',
          programCount: radio?.programCount ?? 0,
          subCount: radio?.subCount ?? 0,
          dj: radio?.dj?.nickname ?? '',
        }))
        .filter((radio) => Number.isFinite(radio.id));

    if (route === '/podcasts/subscribed' && method === 'GET') {
      const data = await this.api.call('/api/djradio/get/subed', { query: { limit: 100, offset: 0 } });
      return sendJson(res, 200, { total: data?.count ?? 0, radios: radioRows(data?.djRadios) });
    }

    if (route === '/podcasts/search' && method === 'GET') {
      const keyword = (query.get('q') ?? '').trim();
      if (!keyword) return sendJson(res, 400, { error: 'missing q' });
      const limit = Math.min(Math.max(Number(query.get('limit')) || 12, 1), 50);
      const data = await this.api.call('/api/search/get/web', {
        query: { csrf_token: '', s: keyword, type: 1009, offset: 0, limit },
      });
      if (data?.code !== 200) {
        return sendJson(res, 502, { error: \`podcast search failed: \${data?.msg ?? data?.code}\` });
      }
      const result = data?.result ?? {};
      return sendJson(res, 200, { total: result.djRadiosCount ?? 0, radios: radioRows(result.djRadios) });
    }

    if (route === '/podcasts/programs' && method === 'GET') {
      const radioId = Number(query.get('radioId'));
      if (!Number.isInteger(radioId) || radioId <= 0) {
        return sendJson(res, 400, { error: 'invalid radioId' });
      }
      const limit = Math.min(Math.max(Number(query.get('limit')) || 30, 1), 100);
      const offset = Math.max(Number(query.get('offset')) || 0, 0);
      const data = await this.api.call('/api/dj/program/byradio', {
        query: { radioId, limit, offset },
      });
      if (data?.code !== 200) {
        return sendJson(res, 502, { error: \`podcast programs failed: \${data?.msg ?? data?.code}\` });
      }
      const tracks = (data?.programs ?? [])
        .map((program) => {
          const track = normalizeTrack(program?.mainSong);
          if (!track) return null;
          // \`programId\` is what a share link or a later "mark played" would need;
          // \`radioName\` lets the row show its show without a second request.
          return { ...track, programId: program?.id, radioId, radioName: program?.radio?.name ?? '' };
        })
        .filter(Boolean);
      return sendJson(res, 200, {
        total: data?.count ?? tracks.length,
        hasMore: Boolean(data?.more),
        tracks: await this.api.withCovers(tracks),
      });
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

const missing = [];
if (!source.includes(IMPORT_ANCHOR)) missing.push('the netease.js import');
if (!source.includes(ROUTE_ANCHOR)) missing.push("the '/new' route");
if (missing.length > 0) {
  console.error(`anchor not found for: ${missing.join(', ')} — the upstream file changed shape.`);
  process.exit(2);
}

if (checkOnly) {
  console.log(`not patched: ${ROUTER}`);
  process.exit(1);
}

const patched = source
  .replace(IMPORT_ANCHOR, IMPORT_REPLACEMENT)
  .replace(ROUTE_ANCHOR, ROUTES + ROUTE_ANCHOR);
await writeFile(ROUTER, patched, 'utf8');
console.log(`patched: ${ROUTER}`);
console.log('restart the harness so the host module is reloaded.');
