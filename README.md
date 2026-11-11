# dsh-file-reveal

Click a file path in a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) conversation and it is highlighted in your OS file manager (Explorer on Windows, Finder on macOS, the desktop file manager on Linux). `Alt` + click opens the file with the default app instead.

A small, dependency-free DSH plugin: it declares a `dsh.bundle` manifest, so it installs like any other DSH plugin. Verified on **DSH Desktop 0.2.0-rc.2** (Windows).

中文说明在下方：[中文](#中文).

## What it does

| Action | Result |
| --- | --- |
| Click a file path in the conversation | Reveal and select the file in the OS file manager |
| `Alt` + click | Open the file with the system default app (directories open in the file manager) |
| `Ctrl` / `⌘` + click | Keep DSH's native behaviour (sidebar preview / new tab) |
| Hover | Pointer cursor + dashed underline; native tooltip explains the shortcuts |
| Relative path (e.g. `research/preview/x1.png`) | Resolved against the **current session's working directory** |
| Invalid path / missing file / non-desktop deployment | A toast explains why |
| Small folder icon in the session header | Toggle the feature on/off (state in `localStorage`); hidden automatically when native desktop APIs are unavailable |

Recognised tokens: Windows absolute paths (`D:\...`), UNC paths (`\\server\share\...`), POSIX absolute paths, `file:///` URLs, and paths with `:42` / `#L24-L30` line anchors. Wrapping quotes, brackets and CJK punctuation are stripped. Inline code, file-mention buttons and local-file links inside the chat region are handled; `pre` code blocks and the composer are deliberately left alone.

## How it works

- Uses the official DSH channel `Session Remote.openWorkspacePath({ path, action: 'reveal' })`: the path is validated by the Host composition filesystem, then `dsh-native-command` calls `explorer.exe /select,` (or the platform equivalent). The security boundary is the same as DSH's built-in "show file location".
- Relative tokens are resolved against the session `cwd` (from the session snapshot). Absolute tokens resolve to themselves.
- The browser half is a hand-written DSH client module (`window.__ModuleLoader__.load({ id, factory })`), so no bundler is involved. It only does DOM event delegation on the conversation region and registers one 24 px header button in the `conversation.session.header.utilities` slot.

## Requirements

- A DSH **desktop** build (the native file-manager command must exist), tested against `0.2.0-rc.2`.
- No npm dependencies, no build step, no network access.

## Install

With the DSH CLI (replace `HQD2938` with this repository's owner, and `desktop` with your profile name if different):

```sh
dsh plugin --profile desktop add github:HQD2938/dsh-file-reveal
```

From a local checkout:

```sh
git clone https://github.com/HQD2938/dsh-file-reveal.git
dsh plugin --profile desktop add /absolute/path/to/dsh-file-reveal
```

Desktop GUI: Plugins → Add plugin → paste the GitHub spec or the local path. Restart or refresh the page if the header icon does not appear immediately.

## Limitations

- Only paths inside the **conversation region** are handled (`[data-conversation-region="chat"]`); `pre` code blocks and the composer are ignored on purpose, to avoid interfering with selection/editing.
- Bare file names without a directory separator (e.g. `README.md`) are not treated as paths — otherwise prose like `package.json` or `ctx.foo` would trigger false positives.
- Relative paths need a session working directory; sessions without one get a hint to use an absolute path.
- The page structure (`data-conversation-*` attributes, header slot names) may change across DSH versions; re-check the selectors after a major upgrade.
- Opening/revealing depends on a desktop host; on remote or headless deployments the header icon hides and clicks explain that the deployment cannot open local files.

## Development

```sh
node --check lib/index.js
node --check lib/client.js
node --test test/parse.test.mjs
```

```
dsh-file-reveal/
  package.json          # dsh.bundle.patch + dsh.client (platform: web)
  cordis.patch.yml      # inserts the plugin row into the profile composition
  lib/index.js          # host half: empty on purpose (the host already owns the native APIs)
  lib/client.js         # browser half: hand-written DSH client module, zero deps, no build
  test/parse.test.mjs   # unit tests for the pure path rules (node --test)
```

## Privacy

The plugin performs no network requests, has no telemetry, and never reads credentials. It only inspects rendered conversation text in the page and forwards the clicked path through DSH's official Session Remote API.

## License

MIT

---

# 中文

对话里的文件路径，点一下就能在**系统文件管理器**里定位（Windows 为资源管理器；`Alt` + 点击用默认应用打开），不用再自己顺着路径找。

DSH 插件（声明了 `dsh.bundle`，可像普通插件一样安装）。验证版本：**DSH Desktop 0.2.0-rc.2（Windows）**。

## 行为

| 操作 | 结果 |
| --- | --- |
| 单击对话里的文件路径（行内代码） | 在文件管理器中定位并选中该文件 |
| `Alt` + 单击 | 用系统默认应用打开该文件（目录则在文件管理器中打开） |
| `Ctrl` / `⌘` + 单击 | 保留 DSH 原有行为（侧栏预览 / 新标签等） |
| 悬停 | 手型 + 虚线下划线；原生 tooltip 说明用法 |
| 相对路径（如 `research/preview/x1.png`） | 用**当前会话的工作目录**解析为绝对路径 |
| 路径无效 / 文件不存在 / 非桌面部署 | 底部 toast 说明原因 |
| 会话头部的小文件夹图标 | 开关本功能（状态存 `localStorage`），桌面能力不可用时自动隐藏 |

识别范围：Windows 绝对路径、UNC、POSIX 绝对路径、`file:///` URL，以及带 `:42` / `#L24-L30` 行号后缀的路径；行内代码外的引号/括号/中文标点会自动剥离。代码块（`pre`）和输入框不处理。

## 安装

```sh
# 用 DSH CLI（HQD2938 换成仓库所有者；profile 名按需改）
dsh plugin --profile desktop add github:HQD2938/dsh-file-reveal

# 本地源码
git clone https://github.com/HQD2938/dsh-file-reveal.git
dsh plugin --profile desktop add /absolute/path/to/dsh-file-reveal
```

桌面端也可以在「插件 → 添加插件」里粘贴 GitHub 规格或本地路径。装完如果没看到头部图标，刷新一次页面。

## 实现与安全

- 走 DSH 官方通道 `Session Remote.openWorkspacePath({ path, action: 'reveal' })`：路径先经 Host 组合文件系统校验，再由 `dsh-native-command` 调起系统文件管理器，安全边界与内置「显示文件位置」一致。
- 浏览器半片是手写的 DSH client module（`window.__ModuleLoader__.load`），零依赖、零构建；只做对话区的事件委托，并在 `conversation.session.header.utilities` 槽注册一个 24px 图标按钮。
- 不联网、无遥测、不读凭据。

## 限制

- 只处理**对话区**内可识别的路径 token（行内代码、文件提及按钮、本地文件链接）；代码块与输入框不处理。
- 单独的文件名（如 `README.md`，无目录分隔符）不会被识别，避免误伤正文里的代码标识符。
- 相对路径依赖当前会话的 cwd；没有工作目录的会话会提示改用绝对路径。
- 页面结构（`data-conversation-*` 属性、头部槽名）随 DSH 版本可能变化；大版本升级后请回归一次。
- 打开/定位依赖桌面 Host；远程或无头部署下图标隐藏，点击会提示不支持打开本机文件。

## 开发

```sh
node --check lib/index.js
node --check lib/client.js
node --test test/parse.test.mjs
```

## 隐私

不发起网络请求、无遥测、不读取凭据；只检查页面中已渲染的对话文本，并把被点击的路径交给 DSH 官方 Session Remote API。

## 许可

MIT
