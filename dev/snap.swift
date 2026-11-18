// snap — render a page in WKWebView (the engine IINA uses) and capture PNG frames.
//
//   snap <url> <width> <height> <steps.json> <outdir> [dark|light]
//
// steps.json: [{"js": "async-js body (may await)", "wait": ms, "snap": "name.png", "rect": [x,y,w,h]}]
// Each step: run js (callAsyncJavaScript, so `await` works and `return` gives a value that is printed),
// then wait, then optionally snapshot (2x) to outdir/name.

import AppKit
import WebKit

struct Step: Decodable { let js: String?; let wait: Double?; let snap: String?; let rect: [Double]? }

final class Runner: NSObject, WKNavigationDelegate {
  let web: WKWebView
  let window: NSWindow
  let steps: [Step]
  let outdir: URL
  var loaded = false

  init(url: URL, size: NSSize, steps: [Step], outdir: URL, dark: Bool) {
    let cfg = WKWebViewConfiguration()
    cfg.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
    web = WKWebView(frame: NSRect(origin: .zero, size: size), configuration: cfg)
    window = NSWindow(contentRect: NSRect(x: -4000, y: -4000, width: size.width, height: size.height),
                      styleMask: [.borderless], backing: .buffered, defer: false)
    window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
    window.contentView = web
    window.orderFrontRegardless()
    self.steps = steps
    self.outdir = outdir
    super.init()
    web.navigationDelegate = self
    web.load(URLRequest(url: url))
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    guard !loaded else { return }
    loaded = true
    Task { @MainActor in await run() }
  }

  @MainActor func run() async {
    for (i, s) in steps.enumerated() {
      if let js = s.js {
        do {
          let r = try await web.callAsyncJavaScript(js, arguments: [:], in: nil, contentWorld: .page)
          if let r, !(r is NSNull) { print("[\(i)] \(r)") }
        } catch { print("[\(i)] JS error: \(error)") }
      }
      if let w = s.wait, w > 0 { try? await Task.sleep(nanoseconds: UInt64(w * 1_000_000)) }
      if let name = s.snap {
        let conf = WKSnapshotConfiguration()
        if let r = s.rect, r.count == 4 { conf.rect = NSRect(x: r[0], y: r[1], width: r[2], height: r[3]) }
        conf.afterScreenUpdates = true
        do {
          let img = try await web.takeSnapshot(configuration: conf)
          if let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
             let png = rep.representation(using: .png, properties: [:]) {
            try png.write(to: outdir.appendingPathComponent(name))
            print("[\(i)] wrote \(name) \(rep.pixelsWide)x\(rep.pixelsHigh)")
          }
        } catch { print("[\(i)] snapshot error: \(error)") }
      }
    }
    exit(0)
  }
}

let a = CommandLine.arguments
guard a.count >= 6 else { print("usage: snap <url> <w> <h> <steps.json> <outdir> [dark|light]"); exit(2) }
let steps = try! JSONDecoder().decode([Step].self, from: Data(contentsOf: URL(fileURLWithPath: a[4])))
let out = URL(fileURLWithPath: a[5])
try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let runner = Runner(url: URL(string: a[1])!, size: NSSize(width: Double(a[2])!, height: Double(a[3])!),
                    steps: steps, outdir: out, dark: a.count < 7 || a[6] != "light")
DispatchQueue.main.asyncAfter(deadline: .now() + 900) { print("timeout"); exit(1) }
app.run()
