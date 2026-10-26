/**
 * Host half of `dsh-music-dock`.
 *
 * It owns no playback state. Everything it shows comes from `@doitian/dsh-music`,
 * which keeps owning the audio element, the queue, the NetEase session and the
 * AI DJ. This plugin is a **view**: it serves one standalone HTML page and the
 * client half frames it inside the sidebar's footer slot.
 *
 * ## Why the page is read from disk on every request
 *
 * The widget is read with `readFile` per request and answered with
 * `cache-control: no-store`, and its mtime is published as `rev` on `/health` so
 * an open page can reload itself when the file changes. That is deliberate: it
 * means the UI can be edited and picked up without reinstalling the plugin and
 * without restarting the harness. It costs one small file read per load.
 *
 * ## Why a standalone page instead of a React component tree
 *
 * The sidebar's `footer.action` slot is a React list slot, but the widget is a
 * whole little app (cover, synced lyrics clock, queue popover, volume). Serving
 * it as its own document keeps that CSS and its timers out of the shell's render
 * path, and makes the exact same UI openable in a browser for review:
 *
 *     http://127.0.0.1:<port>/music-dock/widget
 *
 * @module dsh-music-dock
 */

import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Cordis service dependencies: only the HTTP server is needed. */
export const inject = ['webServer'];

/** Plugin id used by the loader and by the cordis patch. */
export const name = 'dsh-music-dock';

/**
 * Activate the widget route.
 *
 * @param {object} ctx cordis context.
 * @param {object} [config] the entry's `config` block, from the cordis patch.
 * @returns {() => void} disposer withdrawing the route.
 */
export function apply(ctx, config) {
  // `config` arrives as the second argument. Reading `ctx.config` instead would
  // throw ("cannot get property config without inject") unless the plugin also
  // declared a `config` injection — which is not a service, so it cannot be
  // declared that way.
  const settings = config ?? {};
  const base = '/music-dock';
  // Reported by /health only; the widget's own routes are fixed.
  const upstream = `/${String(settings.apiPrefix ?? 'music').replace(/^\/+|\/+$/g, '') || 'music'}`;

  const handler = async (req, res) => {
    // Only the widget document is served; anything else is a 404 with a reason
    // so a mistyped URL is diagnosable from the browser alone.
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }

    if (path === `${base}/widget` || path === base || path === `${base}/`) {
      try {
        const html = await readFile(join(HERE, 'widget.html'), 'utf8');
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store, must-revalidate',
        });
        res.end(req.method === 'HEAD' ? undefined : html);
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `cannot read widget.html: ${error?.message ?? error}` }));
      }
      return;
    }

    if (path === `${base}/health`) {
      // `rev` is widget.html's mtime. The page compares it against the value it
      // booted with and reloads itself when it changes, which is how an edit to
      // the widget reaches a running dock: widget.html is not a plugin module,
      // so plugin HMR does not watch it, and the production desktop shell has no
      // page-reload shortcut.
      let rev = null;
      try {
        rev = String((await stat(join(HERE, 'widget.html'))).mtimeMs);
      } catch {
        /* unreadable file: the page keeps the revision it already has */
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, widget: `${base}/widget`, upstream, rev }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: `not found: ${path}` }));
  };

  const dispose = ctx.webServer.register({ kind: 'prefix', path: base, handler });

  return () => {
    try {
      dispose?.();
    } catch {
      /* a route already withdrawn by the server teardown */
    }
  };
}
