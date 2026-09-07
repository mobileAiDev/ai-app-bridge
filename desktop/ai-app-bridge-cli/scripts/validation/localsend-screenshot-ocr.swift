import Foundation
import Vision
import ImageIO

// Host-side validation helper. It neither connects to Android nor modifies images.
struct OCRResult: Codable {
    let status: String
    let texts: [String]
    let confidences: [Float]
    let error: String?
}

let result: OCRResult
if CommandLine.arguments.count != 2 {
    result = OCRResult(status: "error", texts: [], confidences: [], error: "one_png_path_required")
} else {
    do {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        request.usesLanguageCorrection = false
        let handler = VNImageRequestHandler(url: URL(fileURLWithPath: CommandLine.arguments[1]), options: [:])
        try handler.perform([request])
        let candidates = (request.results ?? []).compactMap { $0.topCandidates(1).first }
        result = OCRResult(status: candidates.isEmpty ? "no_text" : "ok", texts: candidates.map { $0.string }, confidences: candidates.map { $0.confidence }, error: nil)
    } catch {
        result = OCRResult(status: "error", texts: [], confidences: [], error: String(describing: error))
    }
}
let data = try JSONEncoder().encode(result)
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))
