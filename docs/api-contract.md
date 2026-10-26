# dsh-music HTTP API — contract

Live contract for the NetEase Cloud Music panel served by the DSH music plugin.

- **Server observed:** `http://127.0.0.1:62954/music`
- **Plugin:** `@doitian/dsh-music` **1.2.0** (`/Users/<you>/.dsh/profiles/desktop/node_modules/@doitian/dsh-music`)
- **Authority for routes/schemas:** `lib/router.js` (read in full), cross-checked against `lib/feed.js`, `lib/state.js`, `lib/session.js`, `lib/scrobble.js`, `lib/netease.js`, `lib/dj.js`
- **Captured:** 2026-10-23, ~14:25–14:30 (+08:00), against a live, playing session
- **Evidence files in this directory:** `state.sample.json` (full `GET /api/state` dump, rev 3317), `events.sample.txt` (raw `curl -N -m 5` SSE capture), `search.sample.json`

Everything below was verified against the running server unless it is explicitly marked **(source only)**.
Field types come from both the observed JSON and the code that produces it.

---

## 1. Base, transport, auth

| Property | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:62954/music` |
| Route prefix | `/music` — configurable in the plugin (`base`), `PANEL_CONTRACT = 2` |
| Binding | Loopback only (`127.0.0.1`), served by the DSH web server; the plugin registers a `prefix` route |
| Auth | **None.** No cookie, token, header, or query key. Every request in this document was a bare `curl` with no credentials. |
| CORS | **Not enabled.** `OPTIONS /music/api/state` → `404 {"error":"unknown endpoint /state"}`, no `Access-Control-*` headers. |
| Request `Content-Type` | **Ignored.** `{"level":"__probe__"}` sent as `text/plain` and with no `Content-Type` both produced the same 400 validation body as `application/json`. |
| JSON response headers | `Content-Type: application/json; charset=utf-8`, `Content-Length`, `Cache-Control: no-store` |
| Body limit | 256 KiB; over that the request fails with 500 |
| Unknown sub-path | `404 {"error":"not found: /music/foo"}` |
| Unknown API route | `404 {"error":"unknown endpoint /nope"}` |

**Auth model in one sentence:** the NetEase account lives *server-side* (a `MUSIC_U` cookie persisted by the plugin under `~/.dsh/music`), and the HTTP surface has no authentication of its own — anything that can reach `127.0.0.1:62954` can read and mutate playback, the queue, likes and DJ settings.

**Security note (inference, not a probed exploit):** because there is no auth, no origin check, and the body parser ignores `Content-Type`, a cross-origin `text/plain` "simple" POST from a web page could reach these endpoints without a CORS preflight. Treat the panel as trusted-localhost-only; do not expose the port beyond loopback.

### Error model

All API errors are JSON with a human-readable `error` string, and sometimes extra machine-usable fields:

```json
{"error":"unknown endpoint /nope"}
{"error":"unknown level \"__probe__\"","levels":["jymaster","dolby","sky","jyeffect","hires","lossless","exhigh","higher","standard"]}
{"error":"unknown taste level \"__probe__\" (expected liked, none, disliked)","code":"BAD_LEVEL"}
```

Observed statuses: `400` validation, `401` taste change while anonymous, `403` track not entitled to audio, `404` unknown route / track / queue entry, `405` `/stream` with a non-GET/HEAD method, `500` invalid JSON body / handler exception, `502` upstream (NetEase) failure.

Malformed JSON: `POST /api/quality` with `{bad` →

```json
HTTP/1.1 500
{"error":"invalid JSON body"}
```

**Wrong method is a 404, not a 405.** `GET /api/control`, `GET /api/queue`, `POST /api/state` all return
`404 {"error":"unknown endpoint /control"}` etc., because the router matches `method === 'POST'` inside each branch and falls through to the final 404. Only `/stream/<id>` implements 405.

---

## 2. Route table

`M` = mutates server state (playback, queue, likes, settings, session).

| Method | Path (after `/music`) | Body / query | Response | M | Notes |
| --- | --- | --- | --- | --- | --- |
| GET | `/` `/panel` `/panel/` | — | `text/html` (panel page) | no | `__BASE__` replaced with `/music` before serving |
| GET | `/playback.js` | — | `text/javascript` (playback core) | no | `Cache-Control: no-store` |
| GET | `/vendor/qrcode.js` | — | `text/javascript` (vendored QR encoder) | no | `public, max-age=86400` |
| GET | `/health` | — | health object (below) | no | includes plugin diagnostics |
| GET | `/stream/<id>?level=` | query `level` (level id) | audio bytes, `200`/`206`, Range-aware | **read-only but updates `audio.last`** | `400 invalid track id`; `403 {error,code}` when not entitled; `502` CDN failure; `405` other methods |
| GET | `/api/state` | — | full state | no | see §3 |
| GET | `/api/events` | — | `text/event-stream` | no | see §5 |
| POST | `/api/report` | `{trackId?, position?, duration?, playing?, blocked?, ended?, error?}` | full state | **yes** | player reconciliation; `ended:true` or `error` advances the track |
| POST | `/api/seek-consumed` | none | full state | **yes** | consumed by the engine: clears `pendingSeek` |
| POST | `/api/control` | `{action, value?}` | full state | **yes** | actions: `play` `pause` `toggle` `next` `previous` `seek` `volume` `mute` `mode` |
| POST | `/api/play` | `{tracks: Track[], startIndex?}` | full state | **yes** | replaces the queue and starts playing |
| POST | `/api/queue` | `{action, tracks?, index?, keepCurrent?}` | full state | **yes** | actions: `replace` `append` `insert` `remove` `jump` `clear` |
| GET | `/api/search?q=&limit=` | `q` required; `limit` 1–100, default 30 | `{total, tracks: Track[]}` | no | `400 {"error":"missing q"}` on blank/absent `q` |
| GET | `/api/track/<id>` | — | `{track: Track}` | no | `404` if NetEase has no such track |
| GET | `/api/lyric/<id>` | — | `{lrc, translated, romaji, noLyric}` | no | see §6 |
| GET | `/api/info/<id>` | — | song info object | no | album, wiki facts, artist intros; 6 h cache |
| GET | `/api/intro/<id>?lang=en|zh` | `lang` | `{text, …}` | no | always `200`; `{text:"", reason}` when no model/failure; costs one model call |
| GET | `/api/charts` | — | `Chart[]` | no | toplists |
| GET | `/api/playlists` | — | `PlaylistSummary[]` (12) | no | personalized |
| GET | `/api/new` | — | `Track[]` (20) | no | personalized new songs, with covers |
| GET | `/api/playlist/<id>` | — | `{id, name, cover, tracks: Track[]}` | no | tracks carry covers, no taste fields |
| POST | `/api/taste` | `{trackId, level}` | full state | **yes** | `level ∈ {liked, none, disliked}` |
| POST | `/api/feedback` | `{kind, trackId}` | full state | **yes** | `kind ∈ {skips, likes, dislikes}` |
| POST | `/api/boost` | `{trackId, direction, minutes?}` | full state + `boostEffect` | **yes** | `direction ∈ {more, less, none}`; `minutes` clamped 5–720; `none` clears |
| GET | `/api/quality` | — | `{levels, preferred, last}` | no | see §7 |
| POST | `/api/quality` | `{level}` | full state | **yes** | level id from `/quality` |
| POST | `/api/scrobble` | `{enabled: boolean}` | full state | **yes** | listening-history switch |
| GET | `/api/dj/models` | — | `{routes, error, selected, source, configured}` | no | model picker |
| POST | `/api/dj/test` | none | `{source, route, modelError, note, vibe, picked}` | no queue change | **(source only)** runs one throwaway plan — a real model call |
| POST | `/api/dj` | `{enabled?, prompt?, replan?, provider?, model?}` | full state | **yes** | see §7 |
| GET | `/api/login/status` | — | `{loggedIn, account, qr}` | no | |
| POST | `/api/login/qr` | none | `{state, message, loginUrl, unikey, startedAt, expiresAt, loggedIn}` | **yes** | starts/refreshes a QR attempt |
| POST | `/api/login/poll` | none | `{state, message, account?, loginUrl?, loggedIn}` | **yes** | advances QR state; signs in on success |
| POST | `/api/login/cookie` | `{cookie: string}` | `{account, loggedIn:true}` | **yes** | `400 {"error":"missing cookie"}` or 400 if cookie yields no account |
| POST | `/api/login/logout` | none | `{loggedIn:false}` | **yes** | clears cookie, session, like cache, QR |

### `/health` (observed)

```json
{
  "ok": true,
  "prefix": "/music",
  "panelContract": 2,
  "audio": {"preferred": "exhigh", "last": {"trackId": 1958727888, "requested": "exhigh", "served": "exhigh", "downgraded": false, "br": 320000, "type": "mp3", "size": 8102445, "at": 1792736717135}},
  "authenticated": true,
  "account": {"uid": 100000000, "nickname": "listener", "avatar": "https://…/avatar.jpg?param=120y120", "vip": true, "vipType": 110},
  "playing": true,
  "queued": 26,
  "eventStreams": 1,
  "tools": ["music_search","music_play","music_queue","music_control","music_dj","music_now_playing","music_login"],
  "dj": {"enabled": true, "busy": true, "source": "model", "model": null, "modelSource": "agent-default", "lastRoute": "deepseek-account/deepseek-flash", "modelError": null, "pinned": null, "sessionModel": "deepseek-account/deepseek-flash", "resolvedFrom": "agent-default", "sessionId": "music-dj-…", "lastPlanAt": 1792736439321, "error": null},
  "likes": {"cached": 28, "pending": 0, "error": null},
  "scrobble": {"enabled": true, "active": true, "last": {"id": 1396342209, "name": "Do You Want More", "seconds": 88, "ended": false, "at": 1792736717314, "error": null}},
  "dataDir": "/Users/<you>/.dsh/music",
  "session": {"authenticated": true, "nickname": "listener", "vip": true},
  "uptimeMs": 360702784
}
```

`eventStreams` is the number of open `/api/events` streams (the engine plus the panel while shown). The fields after `eventStreams` come from the plugin's `diagnostics()` and are host-specific.

---

## 3. `GET /music/api/state` — full schema

`state` is both the `/state` body and the SSE `data:` payload. It is assembled in `router.snapshot()`:
player snapshot + taste-annotated queue + boosts + account + settings + scrobble + audio, then stamped with `version`.

### 3.1 Observed top-level JSON (queue trimmed to one entry)

```json
{
  "rev": 3317,
  "transportRev": 37,
  "queue": [ { "id": 16432043, "name": "Wish You Were Here", "artists": ["Avril Lavigne"], "album": "Wish You Were Here", "picUrl": "http://p4.music.126.net/sWIqLa1uwrjsBLtFn4tC2g==/109951165966981910.jpg?param=224y224", "duration": 225680, "fee": 1, "vip": true, "mvid": 14326064, "queuedBy": "dj", "liked": false, "disliked": false, "boost": null } ],
  "index": 22,
  "current": { "id": 1958727888, "name": "街头爱", "artists": ["KIV", "mac ova seas", "PSY.P"], "album": "街头爱", "picUrl": "http://p4.music.126.net/2gUdB6JfPqvg0lwAdfqDFw==/109951167585683405.jpg?param=224y224", "duration": 202500, "fee": 8, "vip": false, "mvid": 0, "queuedBy": "dj", "liked": false, "disliked": false, "boost": null },
  "playing": true,
  "volume": 0.8,
  "muted": false,
  "mode": "list",
  "pendingSeek": null,
  "reported": { "trackId": 1958727888, "position": 10009, "duration": 202500, "playing": true, "blocked": false, "at": 1792736727654, "error": null },
  "dj": { "enabled": true, "busy": true, "lastPlanAt": 1792736439321, "lastPlan": { "source": "model", "vibe": "中文说唱为主，街头、硬核与旋律感交替，保持新鲜", "route": "deepseek-account/deepseek-flash", "added": 5, "names": ["Do You Want More — 黄旭BooM", "街头爱 — KIV/mac ova seas/PSY.P", "驳壳枪 — 功夫胖KUNGFU-PEN", "fight to the fire — 法老", "好久不见 — 陆政廷Lil Jet"], "searchedAs": ["说唱", "中文说唱", "说唱精选"] }, "error": null, "modelError": null, "source": "model" },
  "counts": { "queued": 26, "remaining": 3 },
  "boosts": [],
  "account": { "uid": 100000000, "nickname": "listener", "avatar": "https://…/avatar.jpg?param=120y120", "vip": true, "vipType": 110 },
  "authenticated": true,
  "settings": { "level": "", "djEnabled": true, "djPrompt": "我想听一点英文说唱", "djProvider": "", "djModel": "", "djAutoExtendBelow": 3, "djBatchSize": 5, "djSessionId": "music-dj-afcc2572-c41f-4d5d-9560-45ef1509c93a", "scrobble": null },
  "modelSource": "agent-default",
  "scrobble": { "enabled": true, "active": true, "last": { "id": 1396342209, "name": "Do You Want More", "seconds": 88, "ended": false, "at": 1792736717314, "error": null } },
  "audio": { "preferred": "exhigh", "last": { "trackId": 1958727888, "requested": "exhigh", "served": "exhigh", "downgraded": false, "br": 320000, "type": "mp3", "size": 8102445, "at": 1792736717135 } },
  "version": 130
}
```

The complete, untrimmed document is in [`state.sample.json`](./state.sample.json) (26 queue entries, 9.7 KB).

### 3.2 Top-level fields

| Field | Type | Meaning |
| --- | --- | --- |
| `rev` | `number` | Player revision. Bumps on **any** player state change (queue, cursor, transport, volume, mode, reports). Clients use it to decide when to re-read. |
| `transportRev` | `number` | Bumps only when the browser must **act** on the audio element: load a track, play, pause, seek, volume. The engine compares it and re-applies transport. |
| `queue` | `Track[]` | The whole queue, in play order. Can be empty. Persisted (up to 500 entries) so a restart resumes it. |
| `index` | `number` | Cursor into `queue`. `-1` means nothing selected (empty queue). |
| `current` | `Track \| null` | `queue[index]`, or `null` when the queue is empty. Same object shape as a queue entry. |
| `playing` | `boolean` | **Desired** transport state owned by the host, not the actual `<audio>` state. Actual state is in `reported.playing`. |
| `volume` | `number` | 0–1 (float, observed `0.8`). |
| `muted` | `boolean` | Mute flag (independent of `volume`). |
| `mode` | `"list" \| "single" \| "shuffle"` | Repeat/shuffle mode. `list` = normal, `single` = repeat-one, `shuffle` = random. |
| `pendingSeek` | `number \| null` | One-shot absolute seek target in **milliseconds**. Set by control/seek and by jump/removal; read and cleared by the engine via `POST /api/seek-consumed`. `null` = nothing pending. |
| `reported` | `object` | Last telemetry the browser reported (see below). |
| `dj` | `object` | AI DJ status and last plan (see below). |
| `counts` | `object` | `{queued, remaining}` — see below. |
| `boosts` | `Boost[]` | Active temporary "more/less like this" boosts, newest first. Empty array when none. |
| `account` | `object \| null` | Signed-in NetEase account, `null` when anonymous. |
| `authenticated` | `boolean` | Whether a NetEase session exists (distinct from `account`, which can be `null` if the profile call fails). |
| `settings` | `object` | Persisted player settings (see below). |
| `modelSource` | `"panel" \| "config" \| "agent-default" \| "discovered"` | Where the DJ's model route comes from: panel picker, profile patch, the session's own model, or provider discovery. |
| `scrobble` | `object \| null` | Listening-history reporter status; `null` if no scrobbler is wired. |
| `audio` | `object` | Preferred quality + what the last stream actually served. |
| `version` | `number` | **Snapshot-visible version.** Increments whenever anything a client draws changes — including settings, likes, account, boosts, and the served audio — and *not* for a position report. Monotonic; use it to discard out-of-order responses/frames. |

`rev` vs `transportRev` vs `version` (from `state.js` / `feed.js`):

- `rev` — "something in the player changed".
- `transportRev` — "the panel must do something to the audio element".
- `version` — "the *rendered snapshot* changed". It is computed by hashing the snapshot with `rev`, `version`, `reported.position`, `reported.at` and `audio.last.at` removed, so the per-second position report does **not** advance it. Two answers can share a `rev` but never a different ordering of `version`.

### 3.3 `queue[]` entry (identical shape for `current`)

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `number` | NetEase song id (integer). |
| `name` | `string` | Track title. |
| `artists` | `string[]` | Artist names, in billing order. |
| `album` | `string` | Album name (empty string if unknown). |
| `picUrl` | `string \| null` | Cover art, already normalised to `?param=224y224` for non-CDNs; `null` if none. |
| `duration` | `number` | Length in **milliseconds** (e.g. `225680` = 3:45.68). |
| `fee` | `number` | NetEase fee code: `0` free, `1` VIP, `4` album, `8` limited/free-trial. |
| `vip` | `boolean` | Convenience flag, `fee === 1 || fee === 4`. **Not** "requires VIP to stream" in general — `fee: 8` tracks are also gated but report `vip: false`. |
| `mvid` | `number` | Music-video id, `0` when the track has no MV. |
| `queuedBy` | `"dj"` *(observed)* / absent | Who queued it. Present as `"dj"` for DJ picks; **absent** for tracks queued through the HTTP API (`/play`, `/queue` do not pass `queuedBy`, and `tag()` leaves the field off). The code also understands `"user"`. DJ logic keys off `=== 'dj'`, so treat a missing value as "user". |
| `liked` | `boolean` | The **NetEase account's** like state, resolved before the snapshot is written (cached). |
| `disliked` | `boolean` | **Local** dislike (NetEase has no dislike endpoint). `liked` and `disliked` are mutually exclusive, never both `true`. |
| `boost` | `"more" \| "less" \| null` | Active temporary boost for this track, or `null`. Mirrors an entry in `boosts[]`. |

Fields that exist on catalogue tracks but **not** on queue entries: none — the queue entry is the normalized track plus `queuedBy`, `liked`, `disliked`, `boost`. It has **no** play position, no lyric, no album id.

### 3.4 `reported`

Last telemetry posted by the engine (`POST /api/report`). Host-authoritative fields are `playing`; this object is what the browser actually observes.

| Field | Type | Meaning |
| --- | --- | --- |
| `trackId` | `number \| null` | Track the report was for (always the then-current track; a report naming another track is ignored). |
| `position` | `number` | Current playback position in **ms**. |
| `duration` | `number` | Duration the browser knows, in ms (`0` before metadata loads). |
| `playing` | `boolean` | Whether audio is **actually** playing. |
| `blocked` | `boolean` | Whether the browser refused to start audio for want of a user gesture (autoplay block). Cleared as soon as a report says `playing: true`. |
| `at` | `number` | Epoch **ms** when the report was accepted. |
| `error` | `string \| null` | Last per-track playback error (truncated to 300 chars), cleared on track change. The last error survives the automatic skip in the host's `lastError`, but that is not exposed in `state`. |

### 3.5 `dj`

| Field | Type | Meaning |
| --- | --- | --- |
| `enabled` | `boolean` | Continuous DJ on/off (keeps the queue topped up). |
| `busy` | `boolean` | A plan (model call / search) is in flight. |
| `lastPlanAt` | `number \| null` | Epoch ms of the last completed plan. |
| `lastPlan` | `object \| null` | Last plan summary, `null` before the first one: `{source, vibe, route, added, names[], searchedAs[]}`. |
| `lastPlan.source` | `string` | Where the picks came from: observed `"model"`; the DJ also produces plan sources such as `"heuristic"` and `"similar"` (source-derived). |
| `lastPlan.vibe` | `string` | The mood/taste brief used (may be `""`). |
| `lastPlan.route` | `string` | `"provider/model"` that produced the plan. |
| `lastPlan.added` | `number` | How many tracks that plan queued. |
| `lastPlan.names` | `string[]` | `"Name — Artist/Artist"` for each picked track. |
| `lastPlan.searchedAs` | `string[]` | Search keywords the plan used. |
| `error` | `string \| null` | Last planning error (non-model). |
| `modelError` | `string \| null` | Why the model tier last declined, if it did. |
| `source` | `string \| null` | The plan source currently represented by the queue: observed `"model"`; `/play` and `/queue` set it to `"user"`. |

### 3.6 `counts`

| Field | Type | Meaning |
| --- | --- | --- |
| `queued` | `number` | `queue.length`. |
| `remaining` | `number` | Tracks **after** the cursor: `queue.slice(index + 1).length`. Observed `26` queued / index `22` / `3` remaining. **Not** including the current track. |

### 3.7 `boosts[]`

Not observed live (the array was `[]`); shape from `SessionStore.setBoost()` **(source only)**:

```json
{ "id": 1958727888, "name": "街头爱", "artists": ["KIV","mac ova seas","PSY.P"], "direction": "more", "until": 1792738800000 }
```

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `number` | Track id. |
| `name` | `string` | Track name at boost time. |
| `artists` | `string[]` | Artists at boost time. |
| `direction` | `"more" \| "less"` | Push the DJ toward or away from tracks like it. |
| `until` | `number` | Epoch ms when it expires. Expired boosts are filtered out of the array. Max 10 held; a new boost of the same track replaces it. |

### 3.8 `account`

| Field | Type | Meaning |
| --- | --- | --- |
| `uid` | `number` | NetEase user id. |
| `nickname` | `string` | Display name. |
| `avatar` | `string` | Avatar URL (`?param=120y120`). |
| `vip` | `boolean` | Account has a VIP tier. |
| `vipType` | `number` | NetEase VIP tier code (observed `110`). |

`null` when anonymous (and `authenticated: false`).

### 3.9 `settings`

Persisted in the plugin's session document; only some of these have an HTTP setter.

| Field | Type | Default | Meaning | Setter |
| --- | --- | --- | --- | --- |
| `level` | `string` | `""` | Streaming quality chosen **in the panel**. `""` means "no choice"; the profile patch's `audioLevel` then applies (resolved `preferred` falls back to `exhigh`). | `POST /api/quality` |
| `djEnabled` | `boolean` | `false` | DJ keeps the queue topped up. | `POST /api/dj {enabled}` |
| `djPrompt` | `string` | `""` | Free-text taste/mood brief given to the DJ. | `POST /api/dj {prompt}` |
| `djProvider` | `string` | `""` | DJ model provider picked in the panel. `""` = revert to profile patch. | `POST /api/dj {provider}` |
| `djModel` | `string` | `""` | DJ model id picked in the panel. `""` = revert to patch. | `POST /api/dj {model}` |
| `djAutoExtendBelow` | `number` | `3` | Queue length (remaining) that triggers a top-up. | **no HTTP setter** |
| `djBatchSize` | `number` | `5` | Tracks per DJ batch. | **no HTTP setter** |
| `djSessionId` | `string` | `""` | Stable identity for DJ model calls (sent as a per-conversation header). | **no HTTP setter** |
| `scrobble` | `boolean \| null` | `null` | Listening-history switch; `null` = no panel choice, so `config.scrobble` applies. | `POST /api/scrobble` |

### 3.10 `scrobble`

| Field | Type | Meaning |
| --- | --- | --- |
| `enabled` | `boolean` | The switch is on. |
| `active` | `boolean` | Reporting is actually happening: `enabled && authenticated`. |
| `last` | `object \| null` | Last **finished** play report: `{id, name, seconds, ended, at, error}` — `seconds` heard, `ended` whether it played to the end, `error` a message when NetEase refused it. `null` before the first report. |

### 3.11 `audio`

| Field | Type | Meaning |
| --- | --- | --- |
| `preferred` | `string` | Level id used for new streams: `settings.level`, else `config.audioLevel`, else `exhigh`. |
| `last` | `object \| null` | What the most recent `/stream` request served. |

`audio.last`, success shape:

```json
{"trackId":1958727888,"requested":"exhigh","served":"exhigh","downgraded":false,"br":320000,"type":"mp3","size":8102445,"at":1792736717135}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `trackId` | `number` | Track requested. |
| `requested` | `string` | Level asked for (`?level=` or preferred). |
| `served` | `string \| null` | Level actually served after the downgrade ladder; `null` on failure. |
| `downgraded` | `boolean` | `served !== requested`. |
| `br` | `number` | Bitrate in bps (`320000`). |
| `type` | `string` | Container/codec: `"mp3"` or `"flac"`. |
| `size` | `number` | File size in bytes. |
| `at` | `number` | Epoch ms. |

Failure shape (`served: null`, `error` instead of `br/type/size`):

```json
{"trackId":123,"requested":"hires","served":null,"downgraded":false,"error":"unavailable","at":1792736717135}
```

### 3.12 `modelSource`

`"panel"` (provider/model saved from the panel) · `"config"` (profile patch pins a route) · `"agent-default"` (DJ follows the session's own model) · `"discovered"` (falls back to provider discovery).

---

## 4. `GET /music/api/events` — SSE

Headers on the response:

```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-store
X-Accel-Buffering: no
```

Wire format (exact, from `curl -sN -m 5`):

```
retry: 2000

event: state
data: {"rev":3373,"transportRev":44,"queue":[…],"version":…}

```

- **One event name only: `state`.** No `id:` lines, no `Last-Event-ID`, no replay — a reconnecting client gets the current snapshot, which is sufficient because every frame is the whole document.
- The first frame is sent **immediately** on connect (the newcomer is queued through the same write path as everyone else, so a newcomer's first state can never land after a newer one).
- Subsequent frames are written when the snapshot's *visible* content changes: on player bumps, after **any** non-GET API write, and on a 5 s sweep that catches changes nothing announces (a boost expiring, a like resolving in the background, a sign-in).
- A frame is **not** sent for the once-per-second position report; `reported.position` moving does not fire an event. Consequently a client must not expect an event per second — use `reported.position` + `at` from the last frame to extrapolate, or poll `/state` (the panel used to poll at 1.5 s; the engine at 500 ms).
- Heartbeat every **25 s**: a comment line `: ping\n\n` (keeps idle connections and the desktop shell's forwarding fetch alive).
- Reconnect delay advertised: **2000 ms** (`retry: 2000`).
- Multiple streams are allowed (`eventStreams` in `/health` counts them); the stream is closed by the server when the route is withdrawn, and the plugin stops its sweep/heartbeat timers when the last client leaves.
- `data:` is the **complete** state document of §3 — not a delta. Parse `JSON.parse(dataLine)` and replace local state.

Raw capture: [`events.sample.txt`](./events.sample.txt).

---

## 5. `POST /music/api/control`

Body: `{"action": string, "value"?: any}`.

| `action` | `value` | Effect | Mutates |
| --- | --- | --- | --- |
| `play` | — | `player.playing = true` | yes |
| `pause` | — | `player.playing = false` | yes |
| `toggle` | — | flip `playing` | yes |
| `next` | — | one step forward: index+1, **wrapping** past the end to 0. In `single` mode it stays on the same track; in `shuffle` it picks a random different track. Sets `pendingSeek: 0`, `playing: true`. A manual next inside the skip window also records a **skip** (taste signal). | yes |
| `previous` | — | one step back: index−1, **wrapping** from 0 to the last track. Same `single`/`shuffle` behaviour. Not recorded as a skip (`move(-1)`), but it does close the current play's history entry. | yes |
| `seek` | `number` ms | sets `pendingSeek` **and** `reported.position` | yes |
| `volume` | `number` 0–1 | sets `volume` (clamped) | yes |
| `mute` | `boolean` | sets `muted` | yes |
| `mode` | `"list" \| "single" \| "shuffle"` | sets `mode` | yes |
| anything else / missing | — | `400 {"error":"unknown action \"…\""}` | no |

**⚠️ Only the action *name* is validated — the value is not.** This was discovered the hard way while probing (and repaired: volume was restored to `0.8`):

| Probe body | Observed | Why |
| --- | --- | --- |
| `{"action":"seek","value":"__probe__"}` | `200`, and `pendingSeek: 0`, `reported.position: 0` | `Math.max(Number(x) \|\| 0, 0)` → `0`: a garbage seek **restarts the track from 0:00** |
| `{"action":"volume","value":"__probe__"}` | `200`, and `volume: 0` | `Number(x) \|\| 0` → `0`: a garbage volume **mutes to 0** |
| `{"action":"mode","value":"__probe__"}` | `200`, `mode` unchanged | `setMode` checks `MODES.includes()` and silently ignores a bad value |
| `{"action":"mute","value":"__probe__"}` | not sent | **source:** `Boolean(x)` → `true`, i.e. any junk mutes |
| `{}` | `400 {"error":"unknown action \"undefined\""}` | no default branch mutation |

So a UI must send well-typed values: integers of ms, floats 0–1, real booleans, and a mode from the enum. Invalid `mode` is the only value that is safely ignored.

Response: the full state document (`200`). The panel is expected to overlay its own optimistic state until the next frame.

---

## 6. Lyrics: `GET /music/api/lyric/<songId>`

- **Raw LRC text, not parsed lines.** The server returns the NetEase fields verbatim (one string per script); splitting `[mm:ss.xx]` is the client's job.
- **Translation is included as a parallel LRC string** (`translated`), and romanization as `romaji` — both `""` when NetEase has none.
- Cached server-side for 24 h. `200` even when there is no lyric (`lrc: ""`, `noLyric: true`).
- Invalid id (`abc`, `0`, negative, non-integer) → `400 {"error":"invalid track id"}`.

Shape:

```json
{
  "lrc": "[00:06.18]词： KIV/ Mac Ova Seas/ Psy. p\n[00:15.72]曲： KIV/ Mac Ova Seas/ Psy. p\n[00:16.71]KIV…",
  "translated": "",
  "romaji": "",
  "noLyric": false
}
```

Observed for queue song `1958727888` (street 街头爱): `lrc` 2647 chars, `translated` and `romaji` empty, `noLyric false`.
Observed for `209397` (太聪明): `lrc` 1088 chars with `[00:00.00] 作词 : 陈绮贞` style header lines, `translated`/`romaji` empty.

| Field | Type | Meaning |
| --- | --- | --- |
| `lrc` | `string` | Original lyrics as LRC, `""` if none. |
| `translated` | `string` | Translation as LRC (same timestamps), `""` if none. |
| `romaji` | `string` | Romanization as LRC, `""` if none. |
| `noLyric` | `boolean` | NetEase explicitly says the track is instrumental / has no lyric. |

Lyric timing caveat: NetEase LRC can carry metadata lines (writers, composer, producer) at the start — a UI that renders every line will show credits as lyrics. There is no server-side distinction. Ambiguity acknowledged: I did not find a field that marks credits.

---

## 7. Catalogue, taste, quality, DJ, login

### 7.1 `/api/search` (GET)

`q` is trimmed and required (`400 {"error":"missing q"}` for absent/blank). `limit` is `Math.min(Math.max(Number(limit) || 30, 1), 100)` — default 30, clamped 1–100. Non-numeric `limit` → 30.

Response: `{total: number, tracks: Track[]}`. Tracks get covers (`withCovers`), and are the normalized catalogue shape — **no** `queuedBy` / `liked` / `disliked` / `boost`.

```json
{"total": 275, "tracks": [{"id": 210049, "name": "布拉格广场", "artists": ["蔡依林","周杰伦"], "album": "看我72变", "picUrl": "https://p4.music.126.net/8D2Pd7EuvGboMyE2xWc47A==/109951172453712025.jpg?param=224y224", "duration": 294600, "fee": 1, "vip": true, "mvid": 186025}]}
```

(Full sample: [`search.sample.json`](./search.sample.json).)

### 7.2 `/api/play` (POST)

```json
{ "tracks": [Track, …], "startIndex": 0 }
```

- `tracks` must be a non-empty array → otherwise `400 {"error":"tracks must be a non-empty array"}` (verified with `{}` and `{"tracks":[]}`).
- `startIndex` optional, default `0`; clamped to `[0, tracks.length-1]`.
- Tracks may be full normalized tracks **or raw NetEase objects** — `normalizeTrack` accepts `{id, name, ar|artists, al|album, dt|duration, fee, mvid, picUrl}` and also `{song: {...}}` wrappers. Minimum requirement: a truthy `id`.
- Effect: replaces the queue, seeks to its start (`pendingSeek` cleared), sets `playing: true`, `dj.source = "user"`. Mutates.

### 7.3 `/api/queue` (POST)

```json
{ "action": "replace", "tracks": [...], "index": 7, "keepCurrent": true }
```

| `action` | Extra fields | Effect | Mutates |
| --- | --- | --- | --- |
| `replace` | `tracks: Track[]` (required to act) | `setQueue(tracks, {source:'user'})` — replaces queue, starts at 0 | yes |
| `append` | `tracks` | append, de-duplicating against ids already queued; starts playing if stopped | yes |
| `insert` | `tracks` | insert directly after the cursor | yes |
| `remove` | `index: number` | remove that position **and record a dislike** for the track if it was unrated | yes |
| `jump` | `index: number` | jump to that position, `pendingSeek = 0`, `playing = true` | yes |
| `clear` | `keepCurrent?: boolean` | empty the queue (or keep only the current track) and request a DJ extension | yes |
| other / missing | — | `400 {"error":"unknown queue action \"…\""}` | no |

⚠️ **`index` is not validated.** From `state.js`: `removeAt(NaN)` → `remove(NaN)` → `index < 0` and `index >= length` are both false for `NaN` → `splice(NaN, 1)` removes index `0`. A non-integer `index` on `remove` therefore deletes the **first** track (and dislikes it). Send a real integer. `jump(NaN)` is harmless (`index < 0` false, `index >= length` false → `this.index = NaN`!), so **also not safe** — it can corrupt the cursor. Always compute `index` from a state/event frame.

Note `remove` is a **taste signal**, not just housekeeping: see `removeFromQueue()` — an unrated removed track is marked `disliked`, and a removed *current* track advances playback. `clear` is explicitly not a judgement and rates nothing.

### 7.4 `/api/taste` (POST)

```json
{ "trackId": 1958727888, "level": "liked" }
```

- `level ∈ {"liked","none","disliked"}` — verified by probe: `400 {"error":"unknown taste level \"__probe__\" (expected liked, none, disliked)","code":"BAD_LEVEL"}`.
- Invalid id: `400 {"error":"invalid track id \"…\"","code":"BAD_ID"}`.
- Writes to NetEase first (`liked` add, or remove when moving to `none`/`disliked`), then to the local mirror. Failures: `401 {code:"ANONYMOUS"}`, `502 {code:"NETWORK"}` (`BAD_ID`/`400`).
- `disliked` also removes the track from the queue wherever it sits (including the current one, which advances playback).
- Response: full state. Mutates.

### 7.5 `/api/feedback` (POST)

```json
{ "kind": "skips", "trackId": 1958727888 }
```

- `kind ∈ {"skips","likes","dislikes"}` — verified: `400 {"error":"unknown feedback kind \"__probe__\""}`.
- `skips`: records a skip in the local taste store (no queue change).
- `likes` / `dislikes`: **toggles** the corresponding level — if the track is already at that level it goes to `none`, otherwise to `liked`/`disliked` (delegates to `applyTaste`, so it can mutate the queue like `/taste`).
- Legacy endpoint kept for old cached pages; prefer `/taste` (which names the target level instead of toggling). Mutates.

### 7.6 `/api/boost` (POST)

```json
{ "trackId": 1958727888, "direction": "more", "minutes": 60 }
```

- `direction ∈ {"more","less","none"}` — verified: `400 {"error":"unknown boost \"__probe__\" (expected more, less or none)"}`.
- Missing/invalid `trackId` → `400 {"error":"invalid track id \"undefined\""}`; unknown track → `404 {"error":"track 0 not found"}`.
- `minutes` optional, default 60, clamped **5–720**; `none` clears the boost.
- Response: full state **plus** `boostEffect` `{queued, removed}`. Mutates (settings, and the DJ may insert/remove tracks immediately).

### 7.7 `/api/quality`

`GET` → `{levels: [{id,label,kind}], preferred, last}` (observed). `kind` is `"flac"` or `"mp3"`; levels in downgrade order:

```json
{"levels":[
 {"id":"jymaster","label":"超清母带 / Master","kind":"flac"},
 {"id":"dolby","label":"杜比全景声 / Dolby Atmos","kind":"flac"},
 {"id":"sky","label":"沉浸环绕声 / Immersive","kind":"flac"},
 {"id":"jyeffect","label":"沉浸声 / Spatial","kind":"flac"},
 {"id":"hires","label":"Hi-Res 无损 / Hi-Res lossless","kind":"flac"},
 {"id":"lossless","label":"无损 / Lossless","kind":"flac"},
 {"id":"exhigh","label":"极高 / 320 kbps","kind":"mp3"},
 {"id":"higher","label":"较高 / 192 kbps","kind":"mp3"},
 {"id":"standard","label":"标准 / 128 kbps","kind":"mp3"}],
 "preferred":"exhigh","last":{…}}
```

`POST {"level": "<id>"}` → full state; unknown/missing level → `400` with the accepted ids (verified). Only affects the **next** stream load or seek; the running stream keeps its bytes. Mutates `settings.level`.

### 7.8 `/api/dj` (POST)

```json
{ "enabled": true, "prompt": "rainy afternoon jazz", "replan": true, "provider": "deepseek-account", "model": "deepseek-flash" }
```

All fields optional; only the ones present are applied.

| Field | Type | Effect |
| --- | --- | --- |
| `enabled` | `boolean` | Turns the continuous DJ on/off (`setEnabled`), persists `settings.djEnabled` |
| `prompt` | `string` | Sets the mood/taste brief (`setPrompt`), persists `settings.djPrompt`; if the DJ is on, triggers a re-plan |
| `replan` | `boolean` | Force an immediate top-up (`topUp({force:true})`) — planning is slow, so the HTTP answer returns first and results arrive via SSE |
| `provider` | `string` | Persists `settings.djProvider`; `""` reverts to the profile pin |
| `model` | `string` | Persists `settings.djModel`; `""` reverts to the profile pin |

Enabling with an empty queue also plans. Response is the current state; the plan lands later. Mutates.

**Not probed with invalid values on purpose:** `enabled`/`prompt`/`replan` are applied whenever they are `!== undefined` and are **not type-checked** — `{"enabled":"__probe__"}` would switch the DJ on (truthy string), and any non-false value re-plans. The schema above is from `router.js` / `dj.js` read directly, which is safe.

`GET /api/dj/models` (observed):

```json
{"routes":[{"provider":"deepseek-official","models":[{"id":"deepseek-v4-flash","name":"DeepSeek-V4-Flash"}, …]}, …],
 "error":null,
 "selected":{"provider":null,"model":null},
 "source":"agent-default",
 "configured":{"provider":null,"model":null}}
```

`routes[].provider` + `routes[].models[{id,name}]`; `selected` is the effective route (can be inherited, hence not necessarily one of `routes`); `configured` is the patch pin so a picker can offer "revert".

`POST /api/dj/test` **(source only)** — runs one throwaway plan with a count of 1. It makes a real model call but queues nothing:

```json
{"source":"model","route":"deepseek-account/deepseek-flash","modelError":null,"note":null,"vibe":"…","picked":["Name — Artist"]}
```

### 7.9 Scrobble, login

- `POST /api/scrobble {"enabled": boolean}` → full state. Verified `400 {"error":"enabled must be true or false"}` for `{}` and for a string. Mutates `settings.scrobble` and the live reporter.
- `GET /api/login/status` → `{loggedIn, account, qr}` (observed; `qr` is `{state, message, loginUrl, unikey, expiresAt, error}` or `{state:"idle", message}`).
- `POST /api/login/qr` → same QR attempt object plus `loggedIn`. `state ∈ {waiting, scanned, success, expired, idle}`; `message` is bilingual.
- `POST /api/login/poll` → `{state, message, account?, loginUrl?, loggedIn}`; advances the attempt (and signs in on success). `error` may appear on poll failure.
- `POST /api/login/cookie {"cookie":"MUSIC_U=…"}` → `{account, loggedIn:true}`; `400 {"error":"missing cookie"}` when absent/non-string (verified); `400` if the cookie yields no account.
- `POST /api/login/logout` → `{loggedIn:false}`; clears the cookie, the session, the like cache and the QR attempt.

---

## 8. Recipes

```bash
BASE=http://127.0.0.1:62954/music

# state
curl -s $BASE/api/state | jq '{playing,volume,mode,index,current,counts}'

# live stream (whole state per frame)
curl -sN $BASE/api/events | while IFS= read -r line; do
  case "$line" in data:*) echo "${line#data: }" | jq -r '[.version,.index,.current.name]|@tsv';; esac
done

# lyric for the current track
ID=$(curl -s $BASE/api/state | jq -r '.current.id')
curl -s $BASE/api/lyric/$ID | jq -r '.lrc' | head -20

# search
curl -s "$BASE/api/search?q=$(printf %s '周杰伦' | jq -sRr @uri)&limit=5" | jq '.tracks[]|{id,name}'
```

jq one-liners for a UI:

```bash
# queue rows as TSV
curl -s $BASE/api/state | jq -r '.queue|to_entries[]|"\(.key)\t\(.value.name)\t\(.value.artists|join("/"))\t\(.value.liked)\t\(.value.disliked)"'
```

---

## 9. Validation behaviours worth quoting (evidence)

| Probe | Result |
| --- | --- |
| `POST /api/control {}` | `400 {"error":"unknown action \"undefined\""}` |
| `POST /api/control {"action":"__probe__"}` | `400 {"error":"unknown action \"__probe__\""}` |
| `POST /api/play {}` | `400 {"error":"tracks must be a non-empty array"}` |
| `POST /api/queue {}` | `400 {"error":"unknown queue action \"undefined\""}` |
| `GET /api/quality {}` (POST empty) | `400 {"error":"unknown level \"undefined\"","levels":[…]}` |
| `POST /api/boost {"trackId":0,"direction":"__probe__"}` | `400 {"error":"unknown boost \"__probe__\" (expected more, less or none)"}` |
| `POST /api/boost {}` | `400 {"error":"invalid track id \"undefined\""}` |
| `POST /api/feedback {"kind":"__probe__"}` | `400 {"error":"unknown feedback kind \"__probe__\""}` |
| `POST /api/taste {"trackId":0,"level":"__probe__"}` | `400 {"error":"unknown taste level \"__probe__\" (expected liked, none, disliked)","code":"BAD_LEVEL"}` |
| `POST /api/scrobble {}` | `400 {"error":"enabled must be true or false"}` |
| `GET /api/search` | `400 {"error":"missing q"}` |
| `GET /api/search?q=%20%20` | `400 {"error":"missing q"}` |
| `GET /api/lyric/abc`, `/api/lyric/0` | `400 {"error":"invalid track id"}` |
| `POST /api/login/cookie {}` and `{"cookie":123}` | `400 {"error":"missing cookie"}` (validated before any state change) |
| `POST /api/quality` body `{bad` | `500 {"error":"invalid JSON body"}` |
| `GET /api/control` | `404 {"error":"unknown endpoint /control"}` |
| `OPTIONS /api/state` | `404 {"error":"unknown endpoint /state"}` |

---

## 10. Method & caveats

- Routes and request schemas were read from `lib/router.js` (the authority); every claim about the live wire was then checked against the running server with `curl`.
- Deliberately **not** sent: any *valid* `/control`, `/play`, `/queue`, `/taste`, `/boost`, `/feedback`, `/dj`, `/quality`, `/scrobble` command, and anything under `/login/*` that changes the session. The only `/login/*` probe was `POST /api/login/cookie` with a missing / non-string cookie, which 400s before any write. `/stream` is documented from source; `/dj/test` and `/intro` are real model calls and were not called (source only, marked above).
- **Probing mistake, disclosed:** `POST /control` validates the action name but **not** the value, so three "invalid" probes actually executed: `seek("__probe__")` → seek to 0 (the current track restarted), `volume("__probe__")` → volume 0, `mode("__probe__")` → ignored. The volume was restored to `0.8` immediately; playback continued on the same track. This is why the recipe in §5 says `control` needs well-typed values.
- Ambiguities left as ambiguities: whether `queue[].queuedBy === "user"` ever appears live (the HTTP routes don't set it); the exact set of `lastPlan.source` values beyond `"model"`; and whether `reported.error`'s cleared-on-track-change means a UI can miss a failure (it can).
- `state` sample (`rev` 3317) is a point-in-time document: the DJ keeps topping up the queue while the session plays (`counts.queued` moved 26 → 28 during this capture window), so field values like `index`, `counts` and `version` will differ when you read it.
