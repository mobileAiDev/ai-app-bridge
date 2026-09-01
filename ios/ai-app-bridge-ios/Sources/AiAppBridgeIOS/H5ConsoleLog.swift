import Foundation

struct AutomaticLogRecord {
    let source: String
    let level: String
    let tag: String
    let message: String
    let data: [String: Any]?
    let partition: MobileFactPartition
    let timestampMs: Int64
}

enum H5ConsoleScripts {
    static let install =
        "(function(){if(window.__aabConsoleHook)return 0;window.__aabConsoleHook=true;" +
        "window.__aabConsoleBuf=[];var names=['log','info','warn','error','debug'];" +
        "names.forEach(function(name){var original=console[name];console[name]=function(){" +
        "var args=Array.prototype.slice.call(arguments);var buf=window.__aabConsoleBuf;" +
        "buf.push({method:name,message:args.map(function(value){return value==null?'':String(value);}).join(' '),atMs:Date.now()});" +
        "if(buf.length>1000)buf.shift();if(original)return original.apply(console,arguments);};});return 1;})()"

    static let drain =
        "(function(){var buf=window.__aabConsoleBuf||[];window.__aabConsoleBuf=[];return JSON.stringify(buf);})()"
}

enum H5ConsoleDrainParser {
    static func parse(_ raw: Any?) -> [(method: String, message: String, atMs: Int64)] {
        let array: [[String: Any]]
        if let values = raw as? [[String: Any]] {
            array = values
        } else if let text = raw as? String,
                  let data = text.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data),
                  let values = object as? [[String: Any]] {
            array = values
        } else {
            return []
        }
        return array.map { item in
            (
                method: item["method"] as? String ?? "log",
                message: item["message"] as? String ?? "",
                atMs: (item["atMs"] as? NSNumber)?.int64Value ?? 0
            )
        }
    }
}
