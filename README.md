# MahoDown

小巧精致的 Windows Markdown 编辑器。

设计规格来自 `Windows Markdown编辑器设计-handoff/windows-markdown`。  
本仓库为独立工作区，与旧 `mdeditor` 半成品分离。

## 技术栈

| 层 | 选型 |
|---|---|
| 壳 | **Tauri 2**（跨平台：Win / macOS / Linux） |
| 编辑器 | TypeScript + Vite + Milkdown Crepe + CodeMirror |
| 业务 | Rust（`src-tauri`） |
| 遗留 | WinUI3 + .NET 8 仍在仓库，作对照 |

## 一键启动（Tauri）

```powershell
# 需已安装：Node.js、Rust (rustup)、WebView2（Win）
npm install
npm run dev
```

打包：

```powershell
npm run build
# 产物在 src-tauri/target/release/bundle/
```

### 旧 WinUI 启动（可选）

```powershell
.\run.ps1
```

## 开发命令

```powershell
# 前端
Push-Location src/editor-web
npm --cache ../../.npm-cache install
npm test
npm run typecheck
npm run build
Pop-Location

# 后端
dotnet build MahoDown.sln -c Debug -p:Platform=x64
dotnet test tests/MahoDown.Core.Tests/MahoDown.Core.Tests.csproj -c Debug -p:Platform=x64
dotnet run --project src/MahoDown.App/MahoDown.App.csproj -c Debug -p:Platform=x64
```

## 当前能力

- 欢迎页：新建 / 打开 / 最近文档
- 三模式：源码 / 分屏 / 富文本
- 专注模式、命令面板（Ctrl+K）、深浅色
- 打开 / 保存 / 另存为、dirty（Milkdown listener）与崩溃恢复草稿
- **图片**：粘贴 / 拖放上传；本地 `img/` 相对路径可预览（WebResource 映射）
- **图床**：本地 / GitHub / PicGo / S3 / SM.MS / 自定义 API（配置表单 + 密钥 DPAPI + 测试连接）
- **导出**：HTML / PDF / Word(.docx) / PNG
- **版本历史**：保存时自动快照、手动快照、定时快照、列表恢复
- **源码模式**：CodeMirror（行号 + Markdown 高亮）；分屏预览 GFM + 代码着色
- 插件页「即将到来」；AI 占位

## 打测试包（发给朋友）

```powershell
.\package.ps1
```

- 目录：`publish/MahoDown-win-x64/`（入口 **`MahoDown.App.exe`**）
- 压缩包：`publish/MahoDown-win-x64.zip`
- 要求：Windows 10 2004+ / Win11 **x64**；[WebView2 运行时](https://developer.microsoft.com/microsoft-edge/webview2/)（Win11 通常自带）
- 脚本会做 5 秒冒烟启动；缺 `MahoDown.App.pri` 时会自动补齐（否则 WinUI 会秒退）

## 品牌资源

- `assets/brand/logo-hat.svg` — 魔女帽（自设计文档提取）
- `assets/brand/logo-book.svg` — 书本图标
- `assets/brand/logo-mark.svg` — 渐变应用标记

安装启动图 v1 不强制；需要商店上架时再补。

## 决策

见 `docs/DECISIONS.md`。
