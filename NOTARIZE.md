# WP4 公证备料：macOS 签名 + 公证（Eric 手动三步）

**纪律**：Apple ID / Developer 账号操作一律 Eric 自己点（DCloud/Apple ID 同理）——本文三步全是 Eric 手动；
我方备料=electron-builder.yml 的 WP4 注释块（证书名占位 + notarize 配置），Eric 跑完三步后解开即可。

## 为什么需要

identity: null 的 dmg 未签名——别人（或重启后的 Gatekeeper 全量校验路径）打开会拦「无法验证开发者」。
公测批次④的落地页分发必须先过这关；自用拖装目前没事（本地构建无 quarantine 属性）。

## Eric 手动三步（约 30-60 分钟，含等苹果生效）

1. **付费 Apple Developer Program 账号**（$99/年）：https://developer.apple.com/programs/enroll/
   ——免费账号出不了 Developer ID 证书，公证（notarization）也必须付费计划。
2. **创建 Developer ID Application 证书**：Xcode → Settings → Accounts → 加付费 Apple ID →
   选中 Team → Manage Certificates… → 左下「+」→ **Developer ID Application**。
   跑完钥匙串里出现 `Developer ID Application: <你的名字> (<TEAM_ID>)`。
3. **存公证凭证到 keychain profile**（终端，app-specific password 在 appleid.apple.com 生成）：
   ```sh
   xcrun notarytool store-credentials "larkwire-notarize" \
     --apple-id "<你的AppleID邮箱>" --team-id "<TEAM_ID>" --password "<app专用密码>"
   ```

## 三步跑完后（我方或 Eric 一行命令）

解开 `electron-builder.yml` 的 WP4 注释块（identity 填证书全名 + `notarize: true`），然后：

```sh
cd <本仓根目录>
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
APPLE_KEYCHAIN_PROFILE=larkwire-notarize npm run dist
```

（两个 MIRROR env 必须——electron-builder 不读 .npmrc，无镜像时 electron zip 与
dmgbuild-bundle 走 GitHub 直连必超时（WP4 干跑实证：600s 请求超时）；公证后同样适用。）

产物 `release/灵鹊-0.1.0-arm64.dmg` = 签名+公证完成态。

## 验收（公证后）——⚠️ 口径修正（2026-09-24 实证）

**验收对象是 .app 本体，不是 dmg**：dmg 容器本身不签名属正常形态（Gatekeeper 验的是拖出来的 .app），
对 dmg 跑 spctl 会报 `rejected source=no usable signature`——**这不是失败，别被误导**。

```sh
spctl -a -vv release/mac-arm64/灵鹊.app        # 期望：accepted source=Notarized Developer ID
xcrun stapler validate release/mac-arm64/灵鹊.app  # 期望：The validate action worked!
```

**2026-09-24 首跑全绿**：签名（0C620A36…=Developer ID Application: chuankai ju (45TYW2FJ26)）
→ `notarization successful` → staple → 上述两条验收过。产物 `release/灵鹊-0.1.0-arm64.dmg`（122M）。
两坑已修（见 yml 注释）：identity 值含冒号必须带引号（YAML parse）、值不得带 `Developer ID Application:` 前缀（electron-builder 报错要求自动匹配）。

拖装验证（新机体验全链）：dmg 拖 /Applications → 首启接管 launchd → 配对/会话/权限卡抽查。

## 备注

- TEAM_ID 查询：钥匙串证书名里自带，或 https://developer.apple.com/account → Membership details。
- app-specific password：appleid.apple.com → 登录与安全 → App 专用密码（不是 Apple ID 主密码，绝不入库/入聊天）。
- 公测批次再加 universal target（arm64+x64 一行配置）；Windows 签名后议。
