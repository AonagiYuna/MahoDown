# MahoDown

小巧精致的跨平台 Markdown 编辑器（Windows 优先）。

设计规格来自 `Windows Markdown编辑器设计-handoff/windows-markdown`。

## 技术栈

| 层 | 选型 |
|---|---|
| 壳 | **Tauri 2 + Rust**（跨平台：Win / macOS / Linux，系统 WebView） |
| 编辑器 | TypeScript + Vite + Milkdown Crepe + CodeMirror 6 |
| 业务 | Rust（`src-tauri/`）：文件 / 设置 / 图床 / 历史 / 导出 / AI |

前后端通过统一的 `bridge_dispatch` 命令总线通信（`src/editor-web/src/bridge.ts` ⇄ `src-tauri/src/bridge.rs`）。

## 一键启动

```powershell
# 需已安装：Node.js、Rust (rustup)、WebView2（Win 通常自带）
npm install
npm run dev
```

打包：

```powershell
npm run build
# 产物在 src-tauri/target/release/bundle/
```

## 开发命令

```powershell
# 前端（src/editor-web）
npm run web:dev        # 仅前端 Vite 开发服务器
npm run web:build      # 前端产物 -> src/editor-web/dist
npm run web:test       # Vitest

Push-Location src/editor-web
npm run typecheck      # tsc --noEmit
Pop-Location

# 后端（src-tauri）
cargo check   --manifest-path src-tauri/Cargo.toml
cargo test    --manifest-path src-tauri/Cargo.toml
```

## 当前能力

- 欢迎页：新建 / 打开 / 最近文档
- 三模式：源码 / 分屏 / 富文本
- 专注模式、命令面板（Ctrl+K）、深浅色
- 打开 / 保存 / 另存为、dirty（Milkdown listener）与崩溃恢复草稿
- **图片**：粘贴 / 拖放上传；本地 `img/` 相对路径可预览
- **图床**：本地 / GitHub / PicGo / S3 / SM.MS / 自定义 API（配置表单 + 密钥 + 测试连接）
- **导出**：HTML / PDF / Word(.docx) / PNG
- **版本历史**：保存时自动快照、手动快照、定时快照、列表恢复
- **源码模式**：CodeMirror（行号 + Markdown 高亮）；分屏预览 GFM + 代码着色
- 插件页「即将到来」；AI（OpenAI 兼容，DeepSeek 默认）：润色 / 续写 / 翻译

## 品牌资源

- `assets/brand/logo-hat.svg` — 魔女帽（自设计文档提取）
- `assets/brand/logo-book.svg` — 书本图标
- `assets/brand/logo-mark.svg` — 渐变应用标记

安装启动图 v1 不强制；需要商店上架时再补。

## 开源与检查更新

菜单 **检查更新** 会查询 GitHub 仓库的 **latest Release**，对比本地版本；有新版时打开浏览器下载安装包。

1. 把代码推到 GitHub 公开仓库  
2. 仓库已配置为 [AonagiYuna/MahoDown](https://github.com/AonagiYuna/MahoDown)（见 `src-tauri/src/update.rs`）  
3. 发版本时打 tag（如 `v0.1.7`），并把 `MahoDown_*_x64-setup.exe` 传到 Release 附件  

详见 [`docs/RELEASES.md`](docs/RELEASES.md)。

## 决策

见 `docs/DECISIONS.md`。
