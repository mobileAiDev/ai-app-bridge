#!/usr/bin/env ruby
# Integrate the pinned main app. Sharing and push require separate acceptance.
require 'xcodeproj'
require 'digest'
require 'json'
require 'fileutils'
require 'pathname'

sample = File.dirname(File.realpath(__FILE__))
upstream = File.join(sample, 'upstream')
ios = File.join(upstream, 'packages/app-mobile/ios')
project_path = File.join(ios, 'Joplin.xcodeproj')
report = File.join(sample, 'build/integration.json')
abort 'Integration already exists; refusing overwrite' if File.exist?(report)

inputs = {
  'packages/app-mobile/ios/Joplin.xcodeproj/project.pbxproj' => 'd94323b5df07df89127bcd4de4c889e3ff016cad99afbee42e39c05636c214f6',
  'packages/app-mobile/ios/AppDelegate.swift' => '168c9c0d65e45048962b287476605d91d3904c6dc302c1b46cd548a19ad6d560',
  'packages/app-mobile/ios/Joplin/Info.plist' => 'd05fc47eefff65135b4595b138fbc13ed3f45bdf3de89aa3a5e3e48f4bbbb105',
  'packages/app-mobile/ios/Podfile' => 'fc68759f29e16a41d000b973402e9b9cfceec435dfb576d2fefbd8ab0971f682'
}
inputs.each do |relative, expected|
  abort "Pinned source changed: #{relative}" unless Digest::SHA256.file(File.join(upstream, relative)).hexdigest == expected
end

app_file = File.join(ios, 'AppDelegate.swift')
app = File.read(app_file)
edits = {
  "import ReactAppDependencyProvider\n" => "import ReactAppDependencyProvider\n#if DEBUG\nimport AiAppBridgeIOS\n#endif\n",
  "  ) -> Bool {\n    let delegate = ReactNativeDelegate()" => "  ) -> Bool {\n#if DEBUG\n    AiAppBridge.shared.start(appName: \"joplin_bridge_sample\")\n#endif\n    let delegate = ReactNativeDelegate()",
  "#if DEBUG\n    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: \".expo/.virtual-metro-entry\")" => "#if BRIDGE_SAMPLE_STANDALONE\n    return Bundle.main.url(forResource: \"main\", withExtension: \"jsbundle\")\n#elseif DEBUG\n    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: \".expo/.virtual-metro-entry\")"
}
edits.each do |old, replacement|
  abort "Pinned AppDelegate anchor changed: #{old}" unless app.scan(old).length == 1
  app = app.sub(old, replacement)
end

podfile_path = File.join(ios, 'Podfile')
podfile = File.read(podfile_path)
share_pods = "\ntarget 'ShareExtension' do\n  pod 'JoplinCommonShareExtension', :path => 'ShareExtension'\nend\n"
abort 'Pinned share Podfile target changed' unless podfile.scan(share_pods).length == 1
podfile = podfile.sub(share_pods, '')
receiver_pod = "  pod 'JoplinRNShareExtension', :path => 'ShareExtension'\n"
abort 'Pinned share receiver Podfile entry changed' unless podfile.scan(receiver_pod).length == 1
podfile = podfile.sub(receiver_pod, "  pod 'JoplinCommonShareExtension', :path => 'ShareExtension'\n" + receiver_pod)

project = Xcodeproj::Project.open(project_path)
target = project.targets.find { |item| item.name == 'Joplin' }
abort 'Pinned Joplin main target absent' unless target
share_dependency = target.dependencies.select { |item| item.target&.name == 'ShareExtension' }
embed = target.copy_files_build_phases.select { |item| item.name == 'Embed App Extensions' }
abort 'Pinned share composition changed' unless share_dependency.length == 1 && embed.length == 1 && embed.first.files.map(&:display_name) == ['ShareExtension.appex']
# The main-app sample deliberately does not package the paid-team share extension.
# Keep its source and the main app's share receiver unchanged.
share_dependency.first.remove_from_project
embed.first.files.each(&:remove_from_project)
embed.first.remove_from_project

package = project.new(Xcodeproj::Project::Object::XCLocalSwiftPackageReference)
bridge = File.expand_path('../../ios/ai-app-bridge-ios', sample)
package.relative_path = Pathname.new(bridge).relative_path_from(Pathname.new(ios)).to_s
project.root_object.package_references << package
product = project.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
product.package = package
product.product_name = 'AiAppBridgeIOS'
target.package_product_dependencies << product
build_file = project.new(Xcodeproj::Project::Object::PBXBuildFile)
build_file.product_ref = product
target.frameworks_build_phase.files << build_file

debug = target.build_configurations.find { |item| item.name == 'Debug' }
abort 'Debug configuration absent' unless debug
debug.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'io.github.mobileaidev.joplin.sample'
debug.build_settings['CODE_SIGN_STYLE'] = 'Automatic'
debug.build_settings['CODE_SIGN_ENTITLEMENTS'] = 'Joplin/BridgeSample.entitlements'
debug.build_settings['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] = '$(inherited) DEBUG BRIDGE_SAMPLE_STANDALONE'
debug.build_settings['FORCE_BUNDLING'] = '1'
debug.build_settings['INFOPLIST_FILE'] = 'Joplin/Info-Bridge.plist'

info = Xcodeproj::Plist.read_from_path(File.join(ios, 'Joplin/Info.plist'))
info['CFBundleDisplayName'] = 'Joplin Bridge'
info['CFBundleURLTypes'] = [{
  'CFBundleTypeRole' => 'Viewer',
  'CFBundleURLName' => 'io.github.mobileaidev.joplin.sample',
  'CFBundleURLSchemes' => ['joplin-bridge-sample']
}]

project.save
File.write(app_file, app)
File.write(podfile_path, podfile)
Xcodeproj::Plist.write_to_path(info, File.join(ios, 'Joplin/Info-Bridge.plist'))
Xcodeproj::Plist.write_to_path({}, File.join(ios, 'Joplin/BridgeSample.entitlements'))
FileUtils.mkdir_p(File.dirname(report))
File.open(report, 'wx') do |out|
  out.write(JSON.pretty_generate({
    source: JSON.parse(File.read(File.join(sample, 'source.json'))),
    scope: 'Standalone main app with original note/editor/storage behavior; share extension and remote push excluded.',
    files: inputs.map do |relative, expected|
      { path: relative, beforeSha256: expected, afterSha256: Digest::SHA256.file(File.join(upstream, relative)).hexdigest }
    end,
    addedFiles: ['Joplin/Info-Bridge.plist', 'Joplin/BridgeSample.entitlements'].map do |relative|
      { path: "packages/app-mobile/ios/#{relative}", sha256: Digest::SHA256.file(File.join(ios, relative)).hexdigest }
    end
  }) + "\n")
end
puts report
