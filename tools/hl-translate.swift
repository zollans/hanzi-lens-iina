// hl-translate — on-device subtitle translation for Hanzi Lens, using Apple's Translation framework.
//
//   hl-translate status <source> <target>
//   hl-translate text <source> <target> <text>
//   hl-translate file <source> <target> <path-to-json-string-array>
//
// Always prints one JSON object on stdout:
//   {"status":"installed|supported|unsupported","results":[...],"error":"..."}

import Foundation
import Translation

func emit(_ obj: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: obj, options: [])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func statusName(_ s: LanguageAvailability.Status) -> String {
  switch s {
  case .installed: return "installed"
  case .supported: return "supported"
  case .unsupported: return "unsupported"
  @unknown default: return "unknown"
  }
}

@main
struct HLTranslate {
  static func main() async {
    let args = CommandLine.arguments
    guard args.count >= 4 else {
      emit(["error": "usage: hl-translate status|text|file <source> <target> [payload]"])
      exit(2)
    }
    let mode = args[1]
    let source = Locale.Language(identifier: args[2])
    let target = Locale.Language(identifier: args[3])
    let status = await LanguageAvailability().status(from: source, to: target)

    if mode == "status" {
      emit(["status": statusName(status)])
      return
    }

    var lines: [String] = []
    if mode == "text", args.count >= 5 {
      lines = [args[4]]
    } else if mode == "file", args.count >= 5,
              let data = FileManager.default.contents(atPath: args[4]),
              let arr = try? JSONSerialization.jsonObject(with: data) as? [String] {
      lines = arr
    } else {
      emit(["status": statusName(status), "error": "no input"])
      exit(2)
    }

    guard status == .installed else {
      emit(["status": statusName(status), "results": [], "error": "language-not-installed"])
      return
    }

    do {
      let session = TranslationSession(installedSource: source, target: target)
      let requests = lines.enumerated().map {
        TranslationSession.Request(sourceText: $0.element, clientIdentifier: String($0.offset))
      }
      var results = Array(repeating: "", count: lines.count)
      for response in try await session.translations(from: requests) {
        if let id = response.clientIdentifier, let i = Int(id) {
          results[i] = response.targetText
        }
      }
      emit(["status": "installed", "results": results])
    } catch {
      emit(["status": statusName(status), "results": [], "error": String(describing: error)])
    }
  }
}
