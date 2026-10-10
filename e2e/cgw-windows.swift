import CoreGraphics
import Foundation

// e2e 只读探针：window server 层（CGWindowList）真相，不经过 System Events/AX。
// 用法：cgw-windows <pid> [pid...] → 每行一个在屏窗口：
//   CGW|<pid>|<layer>|<width>|<height>|<name>
// 当 AX 平面异常（2026-10-08 实测 System Events 全局 wins=0，连 Cursor/Finder 亦然）时，
// 这是验证「面板窗口确实上屏」的兜底通道。
let pids = Set(CommandLine.arguments.dropFirst().compactMap { Int($0) })
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as! [[String: Any]]
for w in list {
    let pid = w[kCGWindowOwnerPID as String] as? Int ?? -1
    if pids.contains(pid) {
        let layer = w[kCGWindowLayer as String] as? Int ?? -1
        let name = w[kCGWindowName as String] as? String ?? ""
        var width = -1
        var height = -1
        if let b = w[kCGWindowBounds as String] as? [String: Any],
           let r = CGRect(dictionaryRepresentation: b as CFDictionary) {
            width = Int(r.width)
            height = Int(r.height)
        }
        print("CGW|\(pid)|\(layer)|\(width)|\(height)|\(name)")
    }
}
