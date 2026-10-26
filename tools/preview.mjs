/**
 * Local preview harness for `dsh-music-dock`.
 *
 * It exists so the widget can be looked at without restarting the harness: the
 * plugin's own route only answers once the desktop app has loaded the plugin,
 * and a new bundle needs a restart. This server serves the same `widget.html`
 * and proxies `/music/*` to the running host, so the page is fed by the real
 * playback state.
 *
 *   node tools/preview.mjs            # http://127.0.0.1:63900
 *   PORT=7000 node tools/preview.mjs
 *
 * The index page draws a sidebar mock around the widget; `/widget` is the bare
 * document, and `/widget?rail=1` is the collapsed 56px rail shape.
 */

import { createServer, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const WIDGET = join(HERE, '..', 'lib', 'widget.html');

// The harness binds a fresh loopback port on every launch, so it cannot be
// baked in. DSH_PORT wins; otherwise ask lsof which port the app is holding.
function detectHarnessPort() {
  if (process.env.DSH_PORT) return Number(process.env.DSH_PORT);
  try {
    const table = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' });
    for (const line of table.split('\n')) {
      if (!line.includes('DeepSeek')) continue;
      const match = line.match(/127\.0\.0\.1:(\d+)/);
      if (match) return Number(match[1]);
    }
  } catch {
    /* no lsof, or nothing listening: fall through */
  }
  return null;
}

/**
 * The upstream port, re-resolved instead of frozen at startup.
 *
 * Resolving once was a bug: restarting the harness moves it to a new port, and
 * a preview pinned to the old one answers every call with a connection failure
 * — which reads exactly like "the feature is broken". A short TTL keeps the
 * `lsof` call off the hot path while still following a restart within seconds.
 */
const PORT_TTL_MS = 4000;
let cachedPort = null;
let cachedAt = 0;

function upstreamPort() {
  if (process.env.DSH_PORT) return Number(process.env.DSH_PORT);
  const now = Date.now();
  if (cachedPort !== null && now - cachedAt < PORT_TTL_MS) return cachedPort;
  const found = detectHarnessPort();
  if (found !== null) cachedPort = found;
  cachedAt = now;
  return cachedPort;
}

const PORT = Number(process.env.PORT ?? 63900);

const MOCK = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>music-dock 预览</title>
<style>
  html, body { height: 100%; margin: 0; }
  body {
    background: radial-gradient(1200px 600px at 70% -10%, #1d2531, #0c0f14 60%);
    font: 13px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
    color: #8b95a7; display: flex; gap: 34px; padding: 30px; align-items: flex-start;
  }
  .side {
    width: 248px; flex: 0 0 auto; display: flex; flex-direction: column; gap: 8px;
    background: rgba(16,20,27,.72); border: 1px solid rgba(255,255,255,.06);
    border-radius: 16px; padding: 10px; min-height: 520px;
    box-shadow: 0 24px 60px rgba(0,0,0,.45);
  }
  .spacer { flex: 1 1 auto; }
  .rail-row { display: flex; align-items: center; gap: 9px; padding: 8px; border-radius: 9px;
              background: rgba(255,255,255,.03); font-size: 12px; }
  .dot { width: 15px; height: 15px; border-radius: 5px; background: rgba(255,255,255,.12); }
  iframe { width: 100%; border: 0; display: block; background: transparent; }
  .note { max-width: 430px; line-height: 1.85; }
  .note h2 { color: #e8ecf3; font-size: 15px; margin: 0 0 10px; }
  .note code { background: rgba(255,255,255,.07); padding: 1px 5px; border-radius: 4px; color: #a9b6c9; }
  .note a { color: #4c9dff; }
  .toggle { margin-top: 14px; display: inline-flex; gap: 6px; }
  .toggle button { background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.1);
                   color: #cbd5e1; border-radius: 7px; padding: 5px 11px; cursor: pointer; font-size: 12px; }
  .toggle button[data-on="1"] { background: rgba(76,157,255,.2); border-color: rgba(76,157,255,.55); color: #9dc7ff; }
</style>
</head>
<body>
  <div class="side">
    <div class="rail-row"><span class="dot"></span>会话</div>
    <div class="rail-row"><span class="dot"></span>文件</div>
    <div class="spacer"></div>
    <iframe id="frame" src="/widget" style="height:168px" scrolling="no"></iframe>
    <div class="rail-row"><span class="dot"></span>设置</div>
  </div>

  <div class="note">
    <h2>music-dock 预览</h2>
    这是真实数据驱动的预览：页面把 <code>/music/*</code> 代理到正在运行的音乐插件，
    所以你看到的是当前正在播放的歌、真实歌词和真实队列。<br><br>
    高度是自适应的——点右下角 <code>☰</code> 或标题栏的 <code>⌄</code> 展开播放列表和 AI DJ，
    这个方框会跟着变高。<br><br>
    单独打开：<a href="/widget" target="_blank">/widget</a> ·
    <a href="/widget?rail=1" target="_blank">/widget?rail=1</a>（56px 导轨态）
    <div class="toggle">
      <button id="wide" data-on="1" onclick="setMode(1)">展开态</button>
      <button id="rail" data-on="0" onclick="setMode(0)">导轨态</button>
    </div>
  </div>

<script>
  var frame = document.getElementById('frame');
  var wide = true;
  function setMode(next) {
    wide = !!next;
    document.getElementById('wide').dataset.on = wide ? '1' : '0';
    document.getElementById('rail').dataset.on = wide ? '0' : '1';
    document.querySelector('.side').style.width = wide ? '248px' : '76px';
    frame.src = wide ? '/widget' : '/widget?rail=1';
    frame.style.height = wide ? '168px' : '44px';
  }
  // The widget asks for the height it needs; the mock honours it like the real slot does.
  addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.type !== 'dsh-music-dock:height') return;
    var next = Number(data.height);
    if (!isFinite(next)) return;
    frame.style.height = Math.max(40, Math.min(wide ? 560 : 44, next)) + 'px';
  });
</script>
</body>
</html>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');

  // Everything the widget calls lives under /music/*; pipe it straight through
  // so the event stream stays a stream.
  if (url.pathname.startsWith('/music/')) {
    const port = upstreamPort();
    if (port === null) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '找不到正在运行的 DSH 实例（lsof 里没有 DeepSeek 监听端口）' }));
      return;
    }
    const proxy = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: url.pathname + url.search,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${port}` },
      },
      (upstream) => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.pipe(res);
      },
    );
    proxy.on('error', (error) => {
      // The port can also move between the lookup and the connect; say which
      // port was tried, because that is the whole failure mode here.
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: `DSH 在 127.0.0.1:${port} 上没有响应: ${error.message}` }));
    });
    req.pipe(proxy);
    return;
  }

  try {
    const body =
      url.pathname === '/widget' || url.pathname === '/widget.html'
        ? await readFile(WIDGET, 'utf8')
        : url.pathname === '/' || url.pathname === '/index.html'
          ? MOCK
          : null;

    if (body === null) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: `not found: ${url.pathname}` }));
      return;
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const detected = upstreamPort();
  console.log(`music-dock preview: http://127.0.0.1:${PORT}/`);
  console.log(`  bare widget    : http://127.0.0.1:${PORT}/widget`);
  console.log(
    detected === null
      ? '  proxying       : /music/* -> (还没有发现运行中的 DSH，启动后会自动跟上)'
      : `  proxying       : /music/* -> http://127.0.0.1:${detected}  (每次请求重新探测)`,
  );
});
