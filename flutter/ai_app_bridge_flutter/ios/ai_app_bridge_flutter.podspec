Pod::Spec.new do |s|
  s.name             = 'ai_app_bridge_flutter'
  s.version          = '0.2.4'
  s.summary          = 'Debug-only Flutter bridge for AI app inspection and control.'
  s.description      = <<-DESC
AI App Bridge Flutter exposes Flutter widget snapshots, runtime actions,
structured logs, network records, state records, events, and H5 adapter
registration so local AI agents can inspect, operate, verify, and iterate on
debug Flutter apps.
                       DESC
  s.homepage         = 'https://github.com/mobileAiDev/ai-app-bridge'
  s.license          = { :file => '../LICENSE' }
  s.author           = { 'mobileAiDev' => 'https://github.com/mobileAiDev' }
  s.source           = { :path => '.' }
  s.source_files     = [
    'ai_app_bridge_flutter/Sources/ai_app_bridge_flutter/**/*.swift',
    'ai_app_bridge_flutter/Sources/AiAppBridgeIOS/**/*.swift'
  ]
  s.dependency 'Flutter'
  s.platform = :ios, '13.0'
  s.swift_version = '5.9'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }
end
