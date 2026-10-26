#!/usr/bin/env node
/**
 * Stop `@doitian/dsh-music` from registering its `sidebar.panellist` entry.
 *
 * ## Why this is a patch and not a slot option
 *
 * The sidebar builds its panel rows from *every* registrant of the
 * `sidebar.panellist` slot:
 *
 *     const next = ctx.slots.entriesOfSlot("sidebar.panellist").map(({ options }) => …)
 *
 * There is no `hidden`, `when` or `enabled` field on a registration, and no
 * filter applied to the list, so a second plugin cannot suppress another's row.
 * The only lever is to stop the host from registering it.
 *
 * ## What is NOT lost
 *
 * Only the in-app nav row goes away. The full player page is still served by
 * the host at `http://127.0.0.1:<port>/music/panel`, which is where the things
 * the dock does not draw live — audio quality, the DJ model picker, the
 * listening-history switch and the song details pane. The `main` slot
 * registration is deliberately left alone.
 *
 * ## It is a patch, and patches are lost
 *
 * `dsh plugin add @doitian/dsh-music` replaces `node_modules`. Re-run this
 * after an upgrade, or when the Music row reappears.
 *
 *   node patches/hide-sidebar-entry.mjs
 *   node patches/hide-sidebar-entry.mjs --check
 */

import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROFILE = process.env.DSH_PROFILE ?? 'desktop';
const CLIENT = join(
  homedir(),
  '.dsh',
  'profiles',
  PROFILE,
  'node_modules',
  '@doitian',
  'dsh-music',
  'lib',
  'client.js',
);

/** Present when the patch is already applied. */
const MARKER = '--- BEGIN dsh-music-dock patch: sidebar entry hidden ---';

/** The exact registration to remove. */
const ANCHOR = `      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, locale: NS, label: () => t('panel') }, MusicIcon),
      );
`;

const REPLACEMENT = `      // --- BEGIN dsh-music-dock patch: sidebar entry hidden ---
      // dsh-music-dock draws the player into this sidebar itself, so the host's
      // own nav row would be a second, redundant entry. The \`main\` page above
      // is intentionally kept: it is still served at /music/panel, which is
      // where audio quality, the DJ model picker and the details pane live.
      // Re-apply with dsh-music-dock/patches/hide-sidebar-entry.mjs after an
      // upgrade, which replaces this file.
      // --- END dsh-music-dock patch ---
`;

const checkOnly = process.argv.includes('--check');

let source;
try {
  source = await readFile(CLIENT, 'utf8');
} catch (error) {
  console.error(`cannot read ${CLIENT}: ${error.message}`);
  console.error('Is @doitian/dsh-music installed in that profile? Set DSH_PROFILE to override.');
  process.exit(1);
}

if (source.includes(MARKER)) {
  console.log(`already patched: ${CLIENT}`);
  process.exit(0);
}

if (!source.includes(ANCHOR)) {
  console.error('anchor not found — the upstream client changed shape, so this patch no longer applies.');
  console.error(`look for the 'sidebar.panellist' registration in ${CLIENT} and remove it by hand.`);
  process.exit(2);
}

if (checkOnly) {
  console.log(`not patched: ${CLIENT}`);
  process.exit(1);
}

await writeFile(CLIENT, source.replace(ANCHOR, REPLACEMENT), 'utf8');
console.log(`patched: ${CLIENT}`);
console.log('restart the harness: a client plugin bundle is composed at boot, so a reload is not enough.');
