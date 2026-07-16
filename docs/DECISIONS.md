# MahoDown 决策记录

## 产品

- 产品名：**MahoDown**
- 平台：Windows 桌面
- 设计来源：`Windows Markdown编辑器设计-handoff/windows-markdown`

## 技术栈（已选定）

### 主线：Tauri 2（跨平台）

| 层 | 选型 | 原因 |
|---|---|---|
| 壳 | **Tauri 2 + Rust** | 跨 Win/macOS/Linux；包小；系统 WebView（Win=WebView2，Linux=WebKitGTK，Mac=WKWebView） |
| 前端 | TypeScript + Vite + Milkdown Crepe + CodeMirror 6 | 复用既有 editor-web |
| 业务 | Rust（`src-tauri`） | 文件/设置/图床/历史/导出；经 `bridge_dispatch` 兼容原命令名 |
| 测试 | Vitest（前端）+ cargo test（后端） | |

### 已移除：WinUI 3 + .NET

早期的 WinUI 3 / .NET 实现（`src/MahoDown.App`、`src/MahoDown.Core`、`tests/`、`MahoDown.sln`）
在初始提交后已删除，只保留 Tauri 主线。如需回溯，见首个提交的历史记录。

## 范围策略

1. **先搭齐产品骨架与主路径**（欢迎页 / 三模式 / 设置壳 / 打开保存 / 本地图床）
2. 图床六种全部接入架构；实现按优先级推进，本地优先
3. AI 功能：OpenAI 兼容协议（DeepSeek 默认）；润色 / 续写 / 翻译
4. 插件：设置页展示「即将到来」，不可启用
5. 技术缺口（插件沙箱、导出细节等）做到对应阶段再定

## 品牌资源

- Logo SVG 已从设计文档提取到 `assets/brand/`
- 安装/启动图：v1 不强制；需要商店上架时再补
- 设计 uploads 探索图不使用
