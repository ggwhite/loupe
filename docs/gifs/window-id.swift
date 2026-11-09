// window-id.swift: lists on-screen windows as "<CGWindowID> <owner> <size> <title>",
// to find the WINDOW that record.sh captures.
//   swift docs/gifs/window-id.swift
import CoreGraphics

let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
for w in windows where (w["kCGWindowLayer"] as? Int) == 0 {
    let b = w["kCGWindowBounds"] as? [String: Any] ?? [:]
    let size = "\(b["Width"] ?? 0)x\(b["Height"] ?? 0)"
    print(w["kCGWindowNumber"] ?? 0, w["kCGWindowOwnerName"] ?? "", size, w["kCGWindowName"] ?? "")
}
