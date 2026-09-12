import Foundation

struct IOSHttpRequest {
    let method: String
    let path: String
    let query: [String: String]
    // Keep duplicates so admission can reject them rather than choosing one.
    let headers: [String: [String]]
    let body: String

    enum ParseError: Error { case invalidRequest, requestTooLarge }

    static func parse(_ data: Data) throws -> IOSHttpRequest? {
        guard let separator = data.range(of: Data("\r\n\r\n".utf8)) else {
            if data.count > 16 * 1024 { throw ParseError.requestTooLarge }
            return nil
        }
        guard separator.lowerBound <= 16 * 1024 else { throw ParseError.requestTooLarge }
        guard let header = String(data: data[..<separator.lowerBound], encoding: .utf8) else { throw ParseError.invalidRequest }
        let lines = header.components(separatedBy: "\r\n")
        let first = lines[0].split(separator: " ").map(String.init)
        guard first.count == 3, first[2] == "HTTP/1.1" else { throw ParseError.invalidRequest }
        var headers: [String: [String]] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":"), colon != line.startIndex else { throw ParseError.invalidRequest }
            let name = String(line[..<colon]).lowercased()
            guard name.range(of: "^[a-z0-9!#$%&'*+.^_`|~-]+$", options: .regularExpression) != nil else { throw ParseError.invalidRequest }
            headers[name, default: []].append(line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces))
        }
        guard headers["transfer-encoding"] == nil else { throw ParseError.invalidRequest }
        let lengths = headers["content-length"] ?? ["0"]
        guard lengths.count == 1, let contentLength = Int(lengths[0]), contentLength >= 0 else { throw ParseError.invalidRequest }
        guard contentLength <= 4 * 1024 * 1024, data.count <= separator.upperBound + 4 * 1024 * 1024 else { throw ParseError.requestTooLarge }
        let bodyStart = separator.upperBound
        guard data.count >= bodyStart + contentLength else { return nil }
        guard let body = String(data: data[bodyStart..<(bodyStart + contentLength)], encoding: .utf8) else { throw ParseError.invalidRequest }
        let parts = first[1].split(separator: "?", maxSplits: 1).map(String.init)
        return IOSHttpRequest(method: first[0], path: parts.first ?? "/",
                              query: parts.count > 1 ? parseQuery(parts[1]) : [:], headers: headers, body: body)
    }

    private static func parseQuery(_ raw: String) -> [String: String] {
        var result: [String: String] = [:]
        for item in raw.split(separator: "&") {
            let parts = item.split(separator: "=", maxSplits: 1).map(String.init)
            let key = parts.first?.removingPercentEncoding ?? ""
            let value = parts.count > 1 ? (parts[1].removingPercentEncoding ?? parts[1]) : ""
            if !key.isEmpty { result[key] = value }
        }
        return result
    }
}
