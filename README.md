# Larkwire Desktop · 灵鹊电脑桌面端

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

灵鹊 Larkwire 是「用手机远程照看、操控电脑端 AI Agent」的工具。本仓是 **macOS 桌面端**：
一个常驻菜单栏的 Electron 壳——扫码配对后，把本机桥（[`@larkwire/core`](https://www.npmjs.com/package/@larkwire/core) 包，
CLI 命令名仍为 `larkwire`，与桌面共用同一份核心）托管起来，配对状态、桥存活、开机自启、权限引导都在这层。

v0.1.1 起**系统守护**也在此壳：看护 Cursor 扩展宿主，CPU 连续满载约 5 分钟即自动结束进程并通知（SIGTERM，绝不强杀），
主窗「系统守护」面板可扳开关、查看可疑进程与近期处置。

> 手机端 App（iOS / Android）闭源，不在本仓。下载：iOS（TestFlight 审核中）/ Android（应用市场即将上架），见 <https://larkwire.kowems.site#download>。

## 三个源码仓

| 仓库 | 内容 | 分发 |
|---|---|---|
| [kowems/larkwire-core](https://github.com/kowems/larkwire-core) | 桥 + 协议（npm `@larkwire/core`，bin 名 `larkwire` / `@larkwire/protocol`） | npm |
| [kowems/larkwire-relay](https://github.com/kowems/larkwire-relay) | 哑中继（WSS 转发，对内容零可见） | npm + Release 单文件 bundle |
| [kowems/larkwire-desktop](https://github.com/kowems/larkwire-desktop) | **本仓**·macOS 桌面端（Electron） | Release 公证 dmg |

## 下载安装

1. 到 [Releases](https://github.com/kowems/larkwire-desktop/releases) 下载最新 `Larkwire-<版本>-arm64.dmg`（Apple Silicon）；
2. 打开 dmg，把「灵鹊」拖入「应用程序」；
3. 从启动台或「应用程序」打开灵鹊。

dmg 已签名 + 公证（Notarized Developer ID）+ staple，首启直接放行，**无需**在「系统设置 → 隐私与安全性」里手动允许。若首次打开提示确认，点「打开」即可。

要求：macOS 12+，Apple Silicon（M 系列芯片）。Intel 版与 Windows 版在后续计划中。

## 配对手机

首次启动后，菜单栏出现灵鹊图标，主窗自动展示配对二维码：

1. 手机上安装灵鹊 App（iOS TestFlight / Android，见 [官网下载页](https://larkwire.kowems.site#download)）；
2. 用 App 扫描电脑窗口的二维码；
3. 电脑窗口出现**配对指纹**（两组字符），与手机上显示的指纹核对一致后，点「一致，完成配对」；
4. 按提示授予**辅助功能**等权限，即可在手机上看到本机 AI Agent 会话。

> 指纹是防止中间人攻击的人工核对环节：只有两端指纹完全一致才点确认。配对全程端到端加密，设备私钥只存在本机，中继只见密文。

## 使用说明

左侧导航五个页面：

| 页面 | 用途 |
|------|------|
| 💻 **会话** | 查看本机各项目下的 AI Agent 会话，按项目分组（点组头展开/收起）；可在手机接管终端、还回、关闭窗口 |
| 📱 **我的手机** | 管理已配对手机；底部按钮在零台时显示「配对手机」、已有手机时显示「＋ 添加手机」（追加，不影响旧配对） |
| 🛡 **系统守护** | CPU 失控兜底开关：看护扩展宿主连续满载约 5 分钟即自动 SIGTERM，可查看可疑进程与近期处置 |
| 📄 **日志** | 查看桥运行日志，便于排查问题 |
| ⚙ **设置** | 开机自启等选项 |

「我的手机」每台手机有两个行内操作：

- **重新配对**：解绑这台手机后自动亮二维码，扫码即可替换（同台或换新机）；
- **解除绑定**：仅解除配对、不亮二维码。

> 关闭窗口不会退出灵鹊——它常驻菜单栏；点菜单栏图标可重新打开。需要完全退出时，在菜单栏图标上右键选「退出」。

## 升级

下载新版 dmg 拖入「应用程序」，在提示「已存在同名项目」时选**替换**，然后重新打开即可。配对与配置保留，无需重新扫码（若正开着 App，先从菜单栏退出再替换）。

## 卸载

先从菜单栏图标退出灵鹊，然后在「应用程序」里把「灵鹊」拖到废纸篓。如需同时清除本地身份与配置，可删除 `~/.larkwire/` 目录（删除后重新安装需重新配对）。

## 从源码开发

需 Node ≥ 22（桥核心用 `node:sqlite`）：

```bash
npm install        # 从 npm 拉 @larkwire/core@^0.1.0，不依赖 monorepo workspace
npm run build      # esbuild 出 dist/（main/preload/renderer）
npm run dev        # 构建并启动 Electron
```

类型检查：

```bash
npm run typecheck
```

端到端冒烟（Playwright + Electron，真实进程不 mock）：

```bash
npx playwright test
```

### 打签名公证 dmg

签名与公证的完整备料见 [NOTARIZE.md](NOTARIZE.md)（Developer ID 证书、notarytool profile、
electron-builder 镜像口径）。凭证就绪后：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
APPLE_KEYCHAIN_PROFILE=larkwire-notarize npm run dist
```

产物在 `release/`（已在 .gitignore）。

## 隐私与安全模型

- 桌面端只是**壳**：所有会话内容经桥与手机端 E2E 加密（tweetnacl box），中继只见信封头
  （类型/收发方/字节数）和密文 body；
- 设备私钥存于本机用户目录，权限随用户；
- 桌面端不收集、不上报任何分析数据。

## License

[MIT](LICENSE) © 2026 Larkwire contributors

## 相关包

- [`@larkwire/core`](https://www.npmjs.com/package/@larkwire/core) — 桥 CLI（命令名 `larkwire`）与核心库
- [`@larkwire/protocol`](https://www.npmjs.com/package/@larkwire/protocol) — 信封/加密协议
- [`@larkwire/relay`](https://www.npmjs.com/package/@larkwire/relay) — 哑中继
