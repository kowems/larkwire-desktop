# Larkwire Desktop · 灵鹊电脑桌面端

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

灵鹊 Larkwire 是「用手机远程照看、操控电脑端 AI Agent」的工具。本仓是 **macOS 桌面端**：
一个常驻菜单栏的 Electron 壳——扫码配对后，把本机桥（[`larkwire`](https://www.npmjs.com/package/larkwire) 包，
CLI 与桌面共用同一份核心）托管起来，配对状态、桥存活、开机自启、权限引导都在这层。

> 手机端 App（iOS / Android）闭源，不在本仓。

## 三个源码仓

| 仓库 | 内容 | 分发 |
|---|---|---|
| [kowems/larkwire](https://github.com/kowems/larkwire) | 桥 + 协议（CLI 核心 `larkwire` / `@larkwire/protocol`） | npm |
| [kowems/larkwire-relay](https://github.com/kowems/larkwire-relay) | 哑中继（WSS 转发，对内容零可见） | npm + Release 单文件 bundle |
| [kowems/larkwire-desktop](https://github.com/kowems/larkwire-desktop) | **本仓**·macOS 桌面端（Electron） | Release 公证 dmg |

## 下载安装

到 [Releases](https://github.com/kowems/larkwire-desktop/releases) 下载 `Larkwire-<版本>-arm64.dmg`
（Apple Silicon），打开后拖入「应用程序」。dmg 已签名 + 公证 + staple，首启无需绕过 Gatekeeper。

要求：macOS 12+，Apple Silicon（M 系列芯片）。Intel 版与 Windows 版在后续计划中。

首次启动后：

1. 菜单栏出现灵鹊图标，窗口展示配对二维码；
2. 手机端 App 扫码完成端到端配对（私钥只在两端，中继只见密文）；
3. 按提示授予辅助功能等权限，即可在手机上看到本机 AI Agent 会话。

## 从源码开发

需 Node ≥ 22（桥核心用 `node:sqlite`）：

```bash
npm install        # 从 npm 拉 larkwire@^0.1.0，不依赖 monorepo workspace
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

- [`larkwire`](https://www.npmjs.com/package/larkwire) — 桥 CLI 与核心库
- [`@larkwire/protocol`](https://www.npmjs.com/package/@larkwire/protocol) — 信封/加密协议
- [`@larkwire/relay`](https://www.npmjs.com/package/@larkwire/relay) — 哑中继
