# dsh-music-dock

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**常驻侧边栏音乐播放器**:封面、歌名歌手、同步歌词(含中文翻译)、进度与音量、队列、搜索、你自己的网易云歌单,以及 AI DJ 开关。界面直接嵌在左侧栏底部、`设置` 上方。

它本身**不播放也不登录**——播放、队列、网易云会话和 AI DJ 全部由 [`@doitian/dsh-music`](https://github.com/doitian/dsh-music) 持有。这个插件只是把它的状态画出来、把你的操作送回去。

> 截图待补。

## 依赖

**必须先装宿主机插件**,否则本插件没有数据可显示:

```
Plugins → Add plugin → @doitian/dsh-music
```

或:

```sh
dsh plugin --profile desktop add @doitian/dsh-music
```

然后安装本插件:

```sh
dsh plugin --profile desktop add github:zy32566/dsh-music-dock
```

重启 Harness。侧边栏底部会出现播放卡片。

## 功能

| 区域 | 内容 |
|---|---|
| 头部 | 波形动画(播放中) · 播放状态 · **`译` 翻译开关** · 展开 |
| 当前曲目 | 封面 · 歌名 · 歌手 · 音质徽章(`320k` / `无损` / `Hi-Res` …) · 红心 |
| 歌词 | 上一句 / **当前句高亮** / 中文翻译 / 下一句,200ms 刷新 |
| 进度 | 可点击跳转的进度条 + 时间 |
| 控制 | 播放模式 · 上一首 · 播放/暂停 · 下一首 · 展开抽屉 |
| 抽屉 | **队列**(打开时自动定位到正在播放的那首) · **歌单** · **搜索** · **播客** |
| AI DJ | 开关 · 心情输入框 · 按新心情重新规划 |

抽屉里的歌单、搜索和播客节目,每一行都有两个按钮:

- **⏭** 插到下一首播放
- **＋** 加到队尾

点歌名本身是"立刻播放"(会替换队列)。

收起成 56px 导轨时,整张卡片退化成一个封面按钮。

## 需要四处宿主补丁(重要)

**补丁一修的是搜索失效**,不打就搜不了;其余三处不打只是体验降级,不影响能不能用。四条命令:

```sh
node patches/fix-search-rate-limit.mjs   # 修搜索(建议必打)
node patches/apply-my-playlists.mjs      # 让"歌单"页显示你自己的歌单
node patches/add-podcast-routes.mjs      # 播客标签页(不打则没有这一页)
node patches/hide-sidebar-entry.mjs      # 去掉宿主自己的那个侧边栏入口
```

脚本都是**幂等**的,并且在上游文件结构变化导致锚点找不到时会**报错退出而不是乱写**。升级 `@doitian/dsh-music` 会覆盖 `node_modules`,升级后四条都重跑一次。加 `--check` 只检查不改。

### 补丁一:修搜索(网易云限流)

宿主的搜索走老接口 `GET /api/search/get/web`,**带账号 Cookie**。网易云现在对这个组合返回:

```json
{"msg":"操作频繁，请稍候再试","code":405}
```

实测(持续数天,不是瞬时):

| 请求 | 结果 |
|---|---|
| `search/get/web` **带 Cookie** | ❌ `code 405` |
| `search/get/web` **不带 Cookie** | ✅ 273 条(连续 3 次稳定) |
| `POST /api/cloudsearch/pc` 带 Cookie | ✅ 273 条 |

`cloudsearch/pc` 虽然能用,但它返回的是**新字段名**(`ar`/`al`/`dt`/`mv`),而宿主的 `normalizeTrack` 读的是旧名(`artists`/`album`/`duration`/`mvid`),换接口要连带重写映射。搜索结果本来就是公开数据,Cookie 在这里不带来任何东西——所以补丁**让搜索请求不带 Cookie**,这是恢复功能的最小改动。

补丁同时修了一个**让故障不可见**的上游 bug:`searchSongs` 只读 `result.songCount ?? 0`,**完全忽略 `code`**,于是 405 被当成正常的"0 条结果"——这就是为什么界面上什么都不说。补丁改成非 200 就抛错,原因能传到播放器里。

**不打补丁**:搜索恒返回 0 条,且不报错。

### 补丁二:暴露"你自己的歌单"

上游**内部实现了** `userPlaylists(uid)`(自建 + 收藏,含 `specialType: 5` 的"我喜欢的音乐"),但**没有任何路由暴露它**。它的 `/api/playlists` 返回的是 `personalizedPlaylist`——个性化推荐,不是你的歌单。

补丁给宿主加一个约 8 行的路由。

**不打补丁**:歌单页自动降级到推荐歌单,不报错。

### 补丁三:播客(电台)

宿主**完全没有播客能力**——它的 Track 模型、队列、音频代理都是围绕歌曲建的。但网易云把**每一期节目也建模成一首歌**:`program.mainSong` 带着和 track 一样的字段。实测:

```
GET /music/stream/3455056090?level=standard
-> HTTP 206  audio/mpeg  ID3…
```

所以节目经宿主自己的 `normalizeTrack` 归一后,就是队列能吃的 Track:

```
id, name, artists, album, picUrl, duration, fee, vip, mvid
```

**播放侧一行都不用改**——`/play`、队列、`/stream`、进度拖拽全部直接复用。缺的只有**列表**,补丁加三个只读路由:

| 路由 | 作用 |
|---|---|
| `GET /api/podcasts/subscribed` | 我订阅的电台 |
| `GET /api/podcasts/search?q=` | 搜电台(`search/get/web` type 1009) |
| `GET /api/podcasts/programs?radioId=` | 某台的节目,返回 Track |

**不打补丁**:dock 的「播客」标签页会报错,其余功能不受影响。

### 补丁四:去掉宿主自己的侧边栏入口

侧边栏是从 `sidebar.panellist` 插槽的**全部注册项**生成行的:

```js
const next = ctx.slots.entriesOfSlot("sidebar.panellist").map(({ options }) => …)
```

注册项上**没有** `hidden` / `when` / `enabled` 字段,列表也不做过滤,所以别的插件无法隐藏别人的行——只能让宿主别注册。去掉之后侧边栏只剩本插件的播放卡片,不会有两个音乐入口。

**不打补丁**:侧边栏会同时出现宿主自己的 `Music` 入口,和本插件的卡片重复。

> ⚠️ 去掉的只是**应用内的导航行**,完整面板并没有消失——宿主仍在 `http://127.0.0.1:<端口>/music/panel` 提供它,**音质切换、AI DJ 模型选择、听歌记录开关、歌曲详情**都在那个页面上(dock 目前不画这些)。`main` 插槽的注册被刻意保留了。

> 更好的做法是把这两处都提 PR 合进上游,那样补丁就不需要了。欢迎去 `doitian/dsh-music` 开 issue。

## 架构

```
dsh-music-dock/
├─ lib/index.js       宿主半边:提供 /music-dock/widget 路由
├─ lib/client.js      client 半边:注册进 sidebar.footer.action
├─ lib/widget.html    全部 UI(原生 JS,零依赖)
├─ patches/           上游补丁
├─ tools/preview.mjs  本地预览:静态页 + 反代 /music/*
└─ docs/api-contract.md   宿主 HTTP API 契约
```

三个值得说明的设计决定:

**1. UI 是一份独立的 HTML 文档,不是 React 树。**
歌词跳行、进度、弹层都有自己的时钟;放在独立文档里,这些重绘完全不进 shell 的渲染路径。副作用是这份 UI 可以单独打开调试:

```
http://127.0.0.1:<port>/music-dock/widget
```

**2. widget.html 每次请求从磁盘读,并带 `cache-control: no-store`。**
宿主在 `/music-dock/health` 暴露它的 mtime 作为 `rev`,页面每 6 秒比对一次,变了就自己 `location.reload()`。这样改 UI **不需要重装插件、不需要重启**——`widget.html` 不是插件模块,HMR 不监听它,而生产版桌面壳没有刷新页面的快捷键。

**3. 高度靠 `postMessage` 协商,不写死。**
抽屉展开时页面会变高,iframe 跟着长(上限 560px),否则内容会被裁掉。

## 本地开发

```sh
node tools/preview.mjs          # http://127.0.0.1:63900
DSH_PORT=55645 node tools/preview.mjs   # 指定 Harness 端口
```

预览页把 `/music/*` 反代到正在运行的 Harness,**每次请求重新探测端口**(Harness 每次启动都会换端口)。所以它显示的是真实播放状态,点歌会真的播。

## 已知问题

- **搜索:靠补丁修复,且随时可能再次被限流**(见上文"补丁一")。网易云对老搜索接口限流是按账号生效的,换关键词、换时间都可能再次触发;补丁让它至少**报错而不是假装没有结果**。
- 部分英文歌网易云没有提供中文翻译,此时翻译行显示为空(不会报错)。
- "我喜欢的音乐"里的曲目依赖宿主已有的 likes 缓存,首次可能较慢。
- dock 不画**音质切换 / AI DJ 模型选择 / 听歌记录开关 / 歌曲详情**,这些仍在宿主的完整面板里(`/music/panel`)。去掉侧边栏入口后,需要时直接用浏览器打开该地址。
- **播客和音乐共用一个队列**(见"补丁三")。播客会排进同一个队列、和歌混在一起;从某期节目点播放会把该台的后 50 期一起排队,方便连听。
- **播客播放时 AI DJ 仍会按阈值补货**,理论上可能在长节目里插入歌曲。节目通常 1–3 小时,而 DJ 只在队列剩余不足 3 首时才补,所以实际很少发生。想要彻底隔离需要另做独立队列。

## 安全

- 本插件**自己不开任何有副作用的接口**,只有一个只读的 widget 路由。
- 但它读取的宿主 `/music/*` 路由**没有鉴权**,只监听回环地址。任何能访问该端口的本机程序都能读取、修改播放状态与收藏。**不要把 Harness 端口转发到公网。**
- 本插件不接触你的网易云 Cookie;登录态由宿主存在 `~/.dsh/music/session.json`。
- 使用非官方接口,网易云改版可能导致取数失效。

## 许可

MIT
