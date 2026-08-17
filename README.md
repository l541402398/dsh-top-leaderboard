# dsh-top-leaderboard

DSH 插件热度榜单：给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web GUI 侧栏加一个「🏆 榜单」按钮，弹窗里浏览/搜索插件、区分插件类型、检测访问权限、一键安装，并带实时安装日志。

## 功能

- 侧栏底部「🏆 榜单」按钮 → 弹窗（搜索 + 排行）。
- 两个 Tab：
  - **热度榜**：dsh-external 生态榜单（本地快照 `data/leaderboard.json`）。
  - **官方 dsh-plugin**：实时拉取 GitHub `dsh-plugin` topic 的公开插件（按 Star 排序）。
- 每个条目显示**类型徽章**：`技能` / `Bundle` / `Cordis` / `Marisa`，以及 **📦 仓库大小**（GitHub 统计，≥100MB 橙色警示；热度榜的大小渐进式补全并缓存）。
- 一键安装：HTTPS 浅克隆优先（强制 HTTP/1.1 规避 HTTP/2 断流 + 自动重试 3 次，公共仓库无需 SSH 密钥），失败退回 SSH——技能拷到 `~/.dsh/skills/`，bundle/cordis 装进 web profile。
- 安装前日志先报告仓库大小，大仓库会预估下载时间，避免不知情克隆大插件。
- 安装接口信任 loopback 与部署声明的 trusted-host（`dsh web --trusted-host`），通过域名访问不会 403。
- 私有仓库名前有 🔒，点击检测访问权限（有权限显示绿色 🔓），结果跨刷新持久化。
- 安装过程实时日志，可展开查看失败原因；「已安装」状态跨刷新持久化。

## 安装

```bash
# 需要 DSH 与 pnpm 已就绪
dsh plugin --profile web add github:<owner>/dsh-top-leaderboard
dsh web   # 重启后刷新 http://127.0.0.1:3080
```

或本地 tarball：

```bash
dsh plugin --profile web add /path/to/dsh-top-leaderboard-0.1.0.tgz
```

## 前置条件

- DeepSeek Harness（`dsh` 命令）与 `pnpm`。
- 安装私有仓库：配置好 GitHub SSH 密钥（`~/.ssh/config` 指向你的密钥，`ssh -T git@github.com` 能登录）。

## License

MIT
