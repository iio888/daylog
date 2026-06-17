# DayLog 打包分发指南（Windows）

本项目的完整 Tauri 编译/打包必须在 **Windows** 上进行（开发用的 Linux 容器装不了 webkit2gtk，仅能跑前端预览与数据层测试）。下面是从零到产出两种分发件的完整步骤。

## 1. 准备 Windows 构建环境（一次性）

- **Rust**：装 [rustup](https://rustup.rs/)，默认 stable-x86_64-pc-windows-msvc 工具链。
- **MSVC 生成工具**：Visual Studio Build Tools，勾选「使用 C++ 的桌面开发」（含 Windows SDK）。
- **Node.js** 18+。
- **WebView2**：开发机一般已自带；最终用户侧由安装包内嵌处理（见下）。

```powershell
git clone <repo> ; cd daylog
npm install
```

## 2. 一键打包

```powershell
npm run tauri build
```

`beforeBuildCommand` 会先 `npm run build` 出前端静态资源，再编译 Rust 并打包。产物：

| 形态 | 路径 | 体积 | 适用 |
|---|---|---|---|
| **绿色单 exe** | `src-tauri\target\release\DayLog.exe` | ~10MB | 免安装、可放 U 盘；依赖目标机已装 WebView2 |
| **离线安装包** | `src-tauri\target\release\bundle\nsis\DayLog_0.1.0_x64-setup.exe` | ~140MB | 内嵌 WebView2 离线安装器，**完全断网的干净机器**也能装 |

> NSIS 安装包内嵌 WebView2 由 `tauri.conf.json` 的 `bundle.windows.webviewInstallMode = offlineInstaller` 决定——这是「离线环境也能装」的关键，体积换可靠。

## 3. 便携（绿色）模式说明

`DayLog.exe` 启动时按以下顺序定位数据目录（见 `src-tauri/src/lib.rs` 的 `data_dir`）：

1. 若 exe **同目录存在 `data\` 文件夹** → 数据（`daylog.db`、`templates\`、`exports\`、`settings.json`）全部写在这里 → **便携模式**，删除整个文件夹即彻底清理，适合 U 盘携带。
2. 否则 → 写入系统应用数据目录 `%APPDATA%\com.daylog.app\`。

分发绿色版时，把 `DayLog.exe` 和一个**空的 `data\`** 一起打包即可。

## 4. 安装包行为

- `installMode: currentUser`：装到当前用户目录，**不需要管理员权限**，不弹 UAC。
- `languages: [SimpChinese, English]` + `displayLanguageSelector: true`：安装向导可选中/英文。
- 数据走 `%APPDATA%\com.daylog.app\`，卸载不删用户数据（手动清理该目录即可）。

## 5. 验收清单（在干净的离线 Win10 上）

- [ ] 断网状态下双击 `*-setup.exe` 能完成安装（含 WebView2，无需联网）。
- [ ] 启动正常显示图标与窗口，记录→回顾→报告全链路可用。
- [ ] 配置本地 Ollama（`http://localhost:11434/v1` + 已 pull 的模型）后，AI 拆分与 AI 周报跑通。
- [ ] 绿色版：`DayLog.exe` + 空 `data\` 放任意目录，数据写入该 `data\`，重启不丢。
- [ ] 主题（设置 → 外观）浅色/深色/跟随系统切换即时生效，重启保持。

## 6. 图标

图标源 `src-tauri/icon-source.png`（1024²）由 `node scripts/gen-icon.mjs` 程序化生成。替换图标：放入新的 1024² PNG 后执行

```powershell
npm run tauri icon src-tauri/icon-source.png
```

会重新生成 `src-tauri/icons/` 下的 `.ico` / 各尺寸 png。

## 7. 代码签名（可选，后续）

未签名的 exe 在 SmartScreen 下会有「未知发布者」提示。如需消除，购买代码签名证书后在 `tauri.conf.json` 的 `bundle.windows` 配置 `certificateThumbprint` / `signCommand`。v1.0 暂不签名。
