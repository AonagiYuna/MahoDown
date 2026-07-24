# 开源与 GitHub 检查更新

MahoDown 通过 **GitHub Releases** 做版本检查（菜单 → 检查更新）。

## 1. 创建仓库

1. 在 GitHub 新建公开仓库（建议名 `mahodown`）
2. 修改 `src-tauri/src/update.rs` 中的常量：

```rust
pub const GITHUB_REPO: &str = "AonagiYuna/MahoDown";
```

仓库：https://github.com/AonagiYuna/MahoDown

3. 推送代码（已含 MIT `LICENSE`）

## 2. 发布新版本

1. 同步版本号（四处一致）：
   - `package.json`
   - `src/editor-web/package.json`
   - `src-tauri/Cargo.toml`
   - `src-tauri/tauri.conf.json`
2. 本地打包：

```powershell
npm run build
```

3. 在 GitHub 创建 **Release**：
   - Tag：`v0.1.7`（必须带版本号；可带或不带前缀 `v`）
   - 标题：随意，如 `MahoDown 0.1.7`
   - 说明：更新日志（会显示在「检查更新」对话框）
   - 附件上传：
     - `src-tauri/target/release/bundle/nsis/MahoDown_0.1.7_x64-setup.exe`（优先）
     - 可选 MSI

4. 发布后，用户点「检查更新」会请求：

```
GET https://api.github.com/repos/{owner}/{repo}/releases/latest
```

并与当前 `CARGO_PKG_VERSION` 比较。

## 3. 行为说明

| 情况 | 表现 |
|------|------|
| 未改 `GITHUB_REPO` 占位符 | 提示先配置仓库 |
| 仓库无任何 Release | 提示已连接但尚无 Release |
| latest ≤ 当前 | 「已是最新版本」 |
| latest > 当前 | 展示说明 + 下载安装包 / 打开 Release 页 |

> 当前实现是 **检查 + 打开浏览器下载**，不会静默自动安装。  
> 若以后要应用内静默更新，可再接入 `tauri-plugin-updater`（需签名密钥）。

## 4. 可选：GitHub Actions 自动打包

可在 `.github/workflows/release.yml` 里对 `v*` tag 跑 `tauri-action` 自动构建并上传资产。本地 `npm run build` 手动发 Release 已足够起步。
