// icon-probe.swift — OS 级应用图标读回探针（S19 用）
//
// 问系统「你认为这个 .app 的图标长什么样」（NSWorkspace → LaunchServices，与 Finder/Dock 同源），
// 再从期望 icns 加载品牌图，两边按同一函数光栅化到 32px（可加 16px）。
//
// 判定为什么不用「全图像素相似度」（实测踩坑，2026-10-05）：
//   品牌图与 Electron 默认图都是「深色内容占主体」，32px 全图容差比对时阳性壳 0.527、
//   未修复壳 0.522，几乎重合——深色背景的巧合相似淹没了真正区别。
// 判定改用「品牌彩色锚点读回」：
//   品牌图的识别点是三个高饱和彩色光点（蓝/绿/橙），Electron 原子图标零彩色。
//   从期望图光栅化结果提取高饱和像素作为锚点（位置+RGB），在 OS 实际渲染的 ±1px 邻域内
//   找「自身同样高饱和、颜色容差内」的匹配；锚点命中率达标 → 通过。
//   实测两尺寸阴阳零重叠（2026-10-05，最终品牌资产+ tol45，e2e 口径）：
//   32px 阳性 21/61(0.34)、16px 阳性 12/14(0.86)，stock Electron 两尺寸均 0。
//   tol35（缺省）下 32px 因 Liquid Glass 容器的色彩漂移只到 18/61(0.295)，
//   故 e2e 显式传 --tolerance 45；单独手工跑本探针对照时留意这一区别。
//
// 关于 macOS 26（Tahoe）的白色圆角容器：系统对旧式平铺 icns 统一套 Liquid Glass 容器
// （Chrome/Cursor 真实 app 经本探针同样有容器，Maps 等新格式资产不套），阴阳壳都有，
// 不是区分点；锚点判定只看内层品牌内容，天然不受容器影响。
//
// stdout 单行 JSON；退出码：
//   0 = 所有尺寸锚点命中率达标；1 = 探针跑通但图标不是品牌图（未修复克隆壳该有的结果）；
//   2 = 用法/运行错误（含期望图没有任何彩色锚点）
//
// 用法：
//   swift icon-probe.swift <appPath> <expectedIcnsPath> [--no-register] [--sizes 32,16]
//                          [--anchor-ratio 0.30] [--min-hits 3]
//                          [--tolerance 35] [--settle-ms 0]
//
// LaunchServices 对新克隆壳可能尚未读盘，默认先 `lsregister -f <appPath>` 强制注册再读图标
// （e2e 每次唯一路径+唯一 bundle id，实测这是最稳口径；--no-register 仅供对照实验）。

import AppKit
import CryptoKit
import Foundation

// MARK: - 参数

struct Options {
    var appPath = ""
    var expectedPath = ""
    var register = true
    var sizes: [Int] = [32, 16]
    var anchorRatio = 0.30
    var minHits = 3
    var colorTolerance = 35
    var settleMs = 0
}

func failUsage(_ msg: String) -> Never {
    FileHandle.standardError.write(Data("icon-probe: \(msg)\n".utf8))
    exit(2)
}

func parseArgs() -> Options {
    var o = Options()
    let args = CommandLine.arguments.dropFirst()
    var positionals: [String] = []
    var it = args.makeIterator()
    while let a = it.next() {
        switch a {
        case "--no-register": o.register = false
        case "--sizes":
            guard let v = it.next() else { failUsage("--sizes 缺值") }
            o.sizes = v.split(separator: ",").compactMap { Int($0) }.filter { $0 > 0 }
            if o.sizes.isEmpty { failUsage("--sizes 解析失败：\(v)") }
        case "--anchor-ratio":
            guard let v = it.next(), let d = Double(v) else { failUsage("--anchor-ratio 缺值/非法") }
            o.anchorRatio = d
        case "--min-hits":
            guard let v = it.next(), let i = Int(v) else { failUsage("--min-hits 缺值/非法") }
            o.minHits = i
        case "--tolerance":
            guard let v = it.next(), let i = Int(v) else { failUsage("--tolerance 缺值/非法") }
            o.colorTolerance = i
        case "--settle-ms":
            guard let v = it.next(), let i = Int(v) else { failUsage("--settle-ms 缺值/非法") }
            o.settleMs = i
        default:
            positionals.append(a)
        }
    }
    if positionals.count != 2 { failUsage("需要 <appPath> <expectedIcnsPath> 两个位置参数") }
    o.appPath = positionals[0]
    o.expectedPath = positionals[1]
    return o
}

// MARK: - 光栅化

/// 把 NSImage 按同一口径绘制到 size×size 的 sRGB-alpha 位图，返回紧凑 RGBA 字节。
/// 实际图标与期望图标都走这里，保证缩放/色彩环境一致。
func rasterize(_ image: NSImage, size: Int) -> (bytes: [UInt8], ms: Double)? {
    let t0 = Date()
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: size,
        pixelsHigh: size,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else { return nil }
    rep.size = NSSize(width: size, height: size)

    NSGraphicsContext.saveGraphicsState()
    guard let ctx = NSGraphicsContext(bitmapImageRep: rep) else {
        NSGraphicsContext.restoreGraphicsState()
        return nil
    }
    NSGraphicsContext.current = ctx
    ctx.imageInterpolation = .high
    ctx.shouldAntialias = true
    image.draw(
        in: NSRect(x: 0, y: 0, width: size, height: size),
        from: .zero,
        operation: .copy,
        fraction: 1.0,
        respectFlipped: false,
        hints: nil
    )
    ctx.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()

    guard let src = rep.bitmapData else { return nil }
    let bpr = rep.bytesPerRow
    var out = [UInt8](repeating: 0, count: size * size * 4)
    for y in 0..<size {
        out.replaceSubrange(y * size * 4 ..< (y + 1) * size * 4,
                            with: UnsafeBufferPointer(start: src.advanced(by: y * bpr), count: size * 4))
    }
    return (out, Date().timeIntervalSince(t0) * 1000)
}

func sha256(_ bytes: [UInt8]) -> String {
    SHA256.hash(data: Data(bytes)).compactMap { String(format: "%02x", $0) }.joined()
}

// MARK: - 彩色锚点

struct Anchor {
    var x: Int
    var y: Int
    var r: Int
    var g: Int
    var b: Int
}

/// 高饱和判定：alpha 实、亮度够、通道差占比大。阈值与 e2e 实测口径一致（Python 原型同值）。
func isVivid(_ bytes: [UInt8], at i: Int) -> Bool {
    let r = Int(bytes[i]), g = Int(bytes[i + 1]), b = Int(bytes[i + 2]), a = Int(bytes[i + 3])
    if a < 128 { return false }
    let mx = max(r, g, b), mn = min(r, g, b)
    return mx > 90 && Double(mx - mn) / Double(mx) > 0.45
}

/// 从期望图光栅字节提取全部高饱和锚点。
func extractAnchors(_ bytes: [UInt8], size: Int) -> [Anchor] {
    var out: [Anchor] = []
    for y in 0..<size {
        for x in 0..<size {
            let i = (y * size + x) * 4
            if isVivid(bytes, at: i) {
                out.append(Anchor(x: x, y: y, r: Int(bytes[i]), g: Int(bytes[i + 1]), b: Int(bytes[i + 2])))
            }
        }
    }
    return out
}

/// 在 OS 实际渲染中，对每个锚点搜 ±1px 邻域，要求匹配像素自身高饱和且三通道差 ≤ tolerance。
func matchAnchors(_ anchors: [Anchor], in actual: [UInt8], size: Int, tolerance: Int) -> Int {
    var hits = 0
    for anc in anchors {
        var found = false
        for dy in -1...1 where !found {
            for dx in -1...1 {
                let x = anc.x + dx, y = anc.y + dy
                if x < 0 || y < 0 || x >= size || y >= size { continue }
                let i = (y * size + x) * 4
                if !isVivid(actual, at: i) { continue }
                if abs(Int(actual[i]) - anc.r) <= tolerance,
                   abs(Int(actual[i + 1]) - anc.g) <= tolerance,
                   abs(Int(actual[i + 2]) - anc.b) <= tolerance {
                    found = true
                    break
                }
            }
        }
        if found { hits += 1 }
    }
    return hits
}

// MARK: - LaunchServices

let LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/"
    + "LaunchServices.framework/Versions/A/Support/lsregister"

@discardableResult
func registerApp(_ path: String) -> (status: Int32, ms: Double) {
    let t0 = Date()
    let p = Process()
    p.executableURL = URL(fileURLWithPath: LSREGISTER)
    p.arguments = ["-f", path]
    p.standardOutput = Pipe()
    p.standardError = Pipe()
    do { try p.run() } catch { return (-1, Date().timeIntervalSince(t0) * 1000) }
    p.waitUntilExit()
    return (p.terminationStatus, Date().timeIntervalSince(t0) * 1000)
}

// MARK: - 主流程

let o = parseArgs()
let totalT0 = Date()

var dirExists: ObjCBool = false
if !FileManager.default.fileExists(atPath: o.appPath, isDirectory: &dirExists) || !dirExists.boolValue {
    failUsage("appPath 不存在或不是目录：\(o.appPath)")
}
if !FileManager.default.fileExists(atPath: o.expectedPath) {
    failUsage("expected 图不存在：\(o.expectedPath)")
}

var registerInfo: [String: Any] = ["done": false]
if o.register {
    let r = registerApp(o.appPath)
    registerInfo = ["done": true, "status": r.status, "ms": round(r.ms * 10) / 10]
}
if o.settleMs > 0 {
    usleep(UInt32(o.settleMs * 1000))
}

guard let expectedImage = NSImage(contentsOfFile: o.expectedPath) else {
    failUsage("期望图加载失败：\(o.expectedPath)")
}
let osImage = NSWorkspace.shared.icon(forFile: o.appPath)

struct SizeResult {
    var size: Int
    var renderActualMs: Double
    var renderExpectedMs: Double
    var actualSha256: String
    var expectedSha256: String
    var anchors: Int
    var anchorHits: Int
    var anchorHitRatio: Double
    var passed: Bool
}

var sizeResults: [SizeResult] = []
var allPassed = true

for size in o.sizes {
    guard let actual = rasterize(osImage, size: size),
          let expected = rasterize(expectedImage, size: size) else {
        failUsage("\(size)px 光栅化失败")
    }
    let anchors = extractAnchors(expected.bytes, size: size)
    if anchors.isEmpty {
        failUsage("期望图在 \(size)px 没有任何高饱和彩色锚点，无法做品牌读回判定：\(o.expectedPath)")
    }
    let hits = matchAnchors(anchors, in: actual.bytes, size: size, tolerance: o.colorTolerance)
    let ratio = Double(hits) / Double(anchors.count)
    let passed = hits >= o.minHits && ratio >= o.anchorRatio
    if !passed { allPassed = false }
    sizeResults.append(SizeResult(
        size: size,
        renderActualMs: round(actual.ms * 10) / 10,
        renderExpectedMs: round(expected.ms * 10) / 10,
        actualSha256: sha256(actual.bytes),
        expectedSha256: sha256(expected.bytes),
        anchors: anchors.count,
        anchorHits: hits,
        anchorHitRatio: round(ratio * 10000) / 10000,
        passed: passed
    ))
}

// 组装 JSON（手拼避免再依赖 JSONEncoder 对字典的排序差异）
var sizesJSON: [String] = []
for r in sizeResults {
    sizesJSON.append("""
    "\(r.size)":{"passed":\(r.passed),"anchors":\(r.anchors),"anchorHits":\(r.anchorHits),\
    "anchorHitRatio":\(r.anchorHitRatio),"renderActualMs":\(r.renderActualMs),\
    "renderExpectedMs":\(r.renderExpectedMs),"actualSha256":"\(r.actualSha256)",\
    "expectedSha256":"\(r.expectedSha256)"}
    """)
}
let registerJSON: String
if (registerInfo["done"] as? Bool) == true {
    registerJSON = #""register":{"done":true,"status":"\#(registerInfo["status"] ?? -1)","ms":\#(registerInfo["ms"] ?? 0)}"#
} else {
    registerJSON = #""register":{"done":false}"#
}
let report = """
{"appPath":\(o.appPath.debugDescription),"expectedPath":\(o.expectedPath.debugDescription),\
\(registerJSON),"anchorRatio":\(o.anchorRatio),"minHits":\(o.minHits),\
"colorTolerance":\(o.colorTolerance),"sizes":{\(sizesJSON.joined(separator: ","))},\
"passed":\(allPassed),"elapsedMs":\(round(Date().timeIntervalSince(totalT0) * 1000) / 1000)}
"""
FileHandle.standardOutput.write(Data(report.utf8))
FileHandle.standardOutput.write(Data("\n".utf8))
exit(allPassed ? 0 : 1)
