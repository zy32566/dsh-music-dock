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
dsh plugin --profile desktop add github:<you>/dsh-music-dock
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
| 抽屉 | **队列**(打开时自动定位到正在播放的那首) · **歌单** · **搜索** |
| AI DJ | 开关 · 心情输入框 · 按新心情重新规划 |

抽屉里的歌单和搜索结果,每一行都有两个按钮:

- **⏭** 插到下一首播放
- **＋** 加到队尾

点歌名本身是"立刻播放"(会替换队列)。

收起成 56px 导轨时,整张卡片退化成一个封面按钮。

## 需要一处宿主补丁(重要)

上游 `@doitian/dsh-music` **内部实现了** `userPlaylists(uid)`(你自建 + 收藏的歌单,含 `specialType: 5` 的"我喜欢的音乐"),但**没有任何路由暴露它**。它的 `/api/playlists` 返回的是 `personalizedPlaylist`——个性化推荐,不是你的歌单。

所以"歌单"标签页要显示你自己的歌单,需要给宿主加一个约 8 行的路由:

```sh
node patches/apply-my-playlists.mjs
```

脚本是**幂等**的,并且在上游文件结构变化导致锚点找不到时会**报错退出而不是乱写**。升级 `@doitian/dsh-music` 会覆盖 `node_modules`,升级后重新跑一次即可。

`--check` 只检查不改:

```sh
node patches/apply-my-playlists.mjs --check
```

**不打补丁也能用**:歌单页会自动降级到推荐歌单,不会报错。

> 更好的做法是把这个路由提 PR 合进上游,那样补丁就不需要了。欢迎去 `doitian/dsh-music` 开 issue。

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

- **搜索恒返回 0 条**。宿主的 `/api/search` 对任何关键词都返回 `{"total":0,"tracks":[]}`,同一会话下 `/lyric`、`/playlists`、`/playlists` 都正常,所以不是鉴权问题,是网易云侧 eapi 搜索接口的问题。**这会同时影响宿主自己的面板**,不是本插件引入的。修它需要改宿主的 `src/sdk/wy/musicSearch.js`。
- 部分英文歌网易云没有提供中文翻译,此时翻译行显示为空(不会报错)。
- "我喜欢的音乐"里的曲目依赖宿主已有的 likes 缓存,首次可能较慢。

## 安全

- 本插件**自己不开任何有副作用的接口**,只有一个只读的 widget 路由。
- 但它读取的宿主 `/music/*` 路由**没有鉴权**,只监听回环地址。任何能访问该端口的本机程序都能读取、修改播放状态与收藏。**不要把 Harness 端口转发到公网。**
- 本插件不接触你的网易云 Cookie;登录态由宿主存在 `~/.dsh/music/session.json`。
- 使用非官方接口,网易云改版可能导致取数失效。

## 许可

MIT
