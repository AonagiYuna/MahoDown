# MahoDown

小巧精致的跨平台 Markdown 编辑器。

[下载最新版](https://github.com/AonagiYuna/MahoDown/releases/latest) · [问题反馈](https://github.com/AonagiYuna/MahoDown/issues)

## 功能

- **三种编辑模式**：源码 · 分屏 · 富文本
- **专注写作**：干净界面，沉浸输入
- **图片**：粘贴 / 拖入；本地相对路径或图床上传（GitHub / PicGo / S3 / SM.MS 等）
- **导出**：HTML、Word、打印 / PDF
- **版本历史**：自动与手动快照，可随时恢复
- **AI 助手**：侧栏对话改文档，润色 / 续写 / 翻译（OpenAI 兼容接口，如 DeepSeek）
- **检查更新**：从本仓库 Releases 获取新版本

## 安装（Windows）

1. 打开 [Releases](https://github.com/AonagiYuna/MahoDown/releases)
2. 下载 `MahoDown_*_x64-setup.exe` 并安装
3. 需要 [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/)（Windows 10/11 一般已自带）

也可在资源管理器中将 `.md` 文件「打开方式」设为 MahoDown。

## 常用快捷键

| 快捷键 | 作用 |
|--------|------|
| `Ctrl+N` | 新建 |
| `Ctrl+O` | 打开 |
| `Ctrl+S` | 保存 |
| `Ctrl+K` | 命令面板 |
| `Ctrl+E` | 专注模式 |
| `Ctrl+P` | 打印 |
| `Ctrl+,` | 设置 |

## 从源码运行

需安装 Node.js、Rust（rustup）。

```bash
npm install
npm run dev
```

打包安装包：

```bash
npm run build
```

产物在 `src-tauri/target/release/bundle/`。

## 许可

[MIT](LICENSE)
