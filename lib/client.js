/**
 * Browser half of `dsh-music-dock`.
 *
 * Hand-written against the shell's client module contract
 * (`window.__ModuleLoader__.load`), so the package needs no bundler step — the
 * same shape `@doitian/dsh-music` uses.
 *
 * It does exactly one thing: put the widget document in the sidebar's
 * `footer.action` slot. All playback, queue, lyric and AI DJ behaviour lives in
 * `widget.html`, served by this plugin's host half and driven by
 * `@doitian/dsh-music`'s HTTP API.
 *
 * ## Why an iframe and not a React tree
 *
 * The widget keeps its own clock (the lyric line changes roughly twice a
 * second) and its own popovers. Rendering it as a document keeps those re-renders
 * off the shell's React tree entirely — the shell only ever re-renders the
 * `<iframe>` element itself, which happens when `wide` flips.
 *
 * It also makes the UI reviewable on its own:
 *
 *     http://127.0.0.1:<port>/music-dock/widget
 *
 * ## Why the source is an absolute HTTP URL
 *
 * The desktop shell runs on the `dsh-app://` scheme, so a relative `/music-dock/…`
 * would resolve against that custom protocol rather than the plugin's HTTP
 * server. The shell publishes its real HTTP origin as
 * `__DSH_TRANSPORT__.streamBaseUrl`; a browser has no transport object and uses
 * the document origin.
 *
 * @module dsh-music-dock/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-music-dock',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    /** Route prefix this plugin's host half serves. Must match lib/index.js. */
    const BASE = '/music-dock';

    /** Cordis services the registration needs. */
    const inject = ['slots'];

    /**
     * Panel height bounds.
     *
     * `wide`/`rail` are the starting sizes, used before the document has
     * measured itself. The page then reports its real height (it grows when the
     * queue tray opens) and the frame follows, clamped by `min`/`max` so a
     * broken measurement cannot push the sidebar's footer off screen.
     */
    const HEIGHT = { wide: 168, rail: 44, min: 40, max: 560 };

    /** Message the widget posts with its measured height. */
    const HEIGHT_MESSAGE = 'dsh-music-dock:height';

    /**
     * The HTTP origin the plugin's routes answer on.
     *
     * The desktop shell publishes its real origin as
     * `__DSH_TRANSPORT__.streamBaseUrl`. Both fallbacks mirror what the shell's
     * own api-gateway does when that field is absent: `document.baseURI` first
     * (a bare document still knows where it was served from), then the page
     * origin. `dsh-app://app` is deliberately skipped — it is the shell's own
     * scheme, and a plugin route does not answer there.
     *
     * @returns {string} origin without a trailing slash, or '' when unknown.
     */
    function httpBase() {
      const usable = (value) => {
        if (typeof value !== 'string' || !value) return '';
        try {
          const url = new URL(value, globalThis.document?.baseURI);
          if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
          return url.origin;
        } catch {
          return '';
        }
      };
      return (
        usable(globalThis.__DSH_TRANSPORT__?.streamBaseUrl) ||
        usable(globalThis.document?.baseURI) ||
        usable(globalThis.location?.origin)
      );
    }

    /** Widget document URL, telling the page which shape the sidebar is in. */
    function widgetUrl(wide) {
      return `${httpBase()}${BASE}/widget${wide ? '' : '?rail=1'}`;
    }

    /**
     * The slot component. The sidebar hands every `footer.action` entry `wide`,
     * which is false while the column is collapsed to its icon rail.
     *
     * @param {{wide?: boolean}} props slot props.
     */
    function MusicDock(props) {
      const wide = props?.wide !== false;
      const [height, setHeight] = React.useState(wide ? HEIGHT.wide : HEIGHT.rail);

      // Follow the shape of the rail: opening the sidebar restores the card,
      // collapsing it back to a 44px strip around the cover.
      React.useEffect(() => {
        setHeight(wide ? HEIGHT.wide : HEIGHT.rail);
      }, [wide]);

      // The page measures itself and asks for the height it needs. Only the
      // height is taken from the message; nothing else is read out of it.
      React.useEffect(() => {
        function onMessage(event) {
          const data = event?.data;
          if (!data || typeof data !== 'object' || data.type !== HEIGHT_MESSAGE) return;
          const next = Number(data.height);
          if (!Number.isFinite(next)) return;
          const limit = wide ? HEIGHT.max : HEIGHT.rail;
          const clamped = Math.max(HEIGHT.min, Math.min(limit, Math.round(next)));
          setHeight((previous) => (previous === clamped ? previous : clamped));
        }
        globalThis.addEventListener('message', onMessage);
        return () => globalThis.removeEventListener('message', onMessage);
      }, [wide]);

      return h('iframe', {
        // Keyed on shape so React swaps the document, not just the query, when
        // the rail opens or closes: the page reads `rail` once at boot.
        key: wide ? 'wide' : 'rail',
        src: widgetUrl(wide),
        title: '音乐',
        allow: 'autoplay; clipboard-write; encrypted-media',
        style: {
          display: 'block',
          width: '100%',
          height: `${height}px`,
          border: 0,
          background: 'transparent',
          colorScheme: 'normal',
          overflow: 'hidden',
          borderRadius: '10px',
          transition: 'height .18s ease',
        },
      });
    }

    /**
     * Register the dock into the sidebar footer.
     *
     * `inject` makes the registration declaration-aware: it waits for the
     * sidebar package that owns the slot instead of racing it.
     *
     * @param {object} ctx client runtime.
     */
    function registerUi(ctx) {
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'music-dock',
            order: 10,
          },
          MusicDock,
        ),
      );
    }

    /**
     * Activate the client contribution.
     *
     * @param {object} ctx client runtime.
     * @returns {() => void} disposer withdrawing the registration.
     */
    function apply(ctx) {
      const ui = ctx.inject(['slots'], () => registerUi(ctx));
      return () => {
        try {
          ui?.dispose?.();
        } catch {
          /* already withdrawn by the slot system */
        }
      };
    }

    exports.MusicDock = MusicDock;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
