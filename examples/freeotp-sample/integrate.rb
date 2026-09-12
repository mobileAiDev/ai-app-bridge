#!/usr/bin/env ruby
# Add the local Bridge package without changing FreeOTP business behavior.
require 'xcodeproj'
require 'digest'
require 'json'
require 'fileutils'

sample = File.dirname(File.realpath(__FILE__))
upstream = File.join(sample, 'upstream')
project_path = File.join(upstream, 'FreeOTP.xcodeproj')
project_file = File.join(project_path, 'project.pbxproj')
app_file = File.join(upstream, 'FreeOTP/AppDelegate.swift')
report = File.join(sample, 'build/integration.json')
abort 'Integration already exists; refusing overwrite' if File.exist?(report)
before = [project_file, app_file].to_h { |path| [path, File.binread(path)] }

app_source = before.fetch(app_file)
import_anchor = "import UIKit\n"
start_anchor = "didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {\n"
abort 'Pinned AppDelegate changed' unless app_source.scan(import_anchor).length == 1 && app_source.scan(start_anchor).length == 1
app_source = app_source.sub(import_anchor, import_anchor + "#if DEBUG\nimport AiAppBridgeIOS\n#endif\n")
app_source = app_source.sub(start_anchor, start_anchor + "        #if DEBUG\n        AiAppBridge.shared.start(appName: \"freeotp_bridge_sample\")\n        #endif\n")

project = Xcodeproj::Project.open(project_path)
target = project.targets.find { |item| item.name == 'FreeOTP' }
abort 'FreeOTP target absent' unless target
abort 'Bridge dependency already present' if target.package_product_dependencies.any? { |item| item.product_name == 'AiAppBridgeIOS' }
package = project.new(Xcodeproj::Project::Object::XCLocalSwiftPackageReference)
package.relative_path = '../../../ios/ai-app-bridge-ios'
project.root_object.package_references << package
product = project.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
product.package = package
product.product_name = 'AiAppBridgeIOS'
target.package_product_dependencies << product
build_file = project.new(Xcodeproj::Project::Object::PBXBuildFile)
build_file.product_ref = product
target.frameworks_build_phase.files << build_file
scene = project.main_group.new_file('../SceneDelegate.swift')
scene.source_tree = 'SOURCE_ROOT'
target.source_build_phase.add_file_reference(scene)
debug = target.build_configurations.find { |item| item.name == 'Debug' }
abort 'Debug configuration absent' unless debug
debug.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'io.github.mobileaidev.freeotp.sample'
debug.build_settings['CODE_SIGN_STYLE'] = 'Automatic'
debug.build_settings['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] = '$(inherited) DEBUG'
debug.build_settings['INFOPLIST_KEY_CFBundleDisplayName'] = 'FreeOTP Bridge'
debug.build_settings['INFOPLIST_FILE'] = '../build/Info-Bridge.plist'
fonts = %w[fa-solid-900.ttf fa-regular-400.ttf fa-brands-400.ttf]
fonts.each do |font|
  references = project.files.select { |item| File.basename(item.path.to_s) == font }
  abort "Expected one upstream font reference: #{font}" unless references.length == 1
  references.first.path = "Support/FontAwesome/#{font}"
  references.first.source_tree = 'SOURCE_ROOT'
end
project.save
File.write(app_file, app_source)

FileUtils.mkdir_p(File.dirname(report))
info = Xcodeproj::Plist.read_from_path(File.join(upstream, 'FreeOTP/Info.plist'))
info['CFBundleDisplayName'] = 'FreeOTP Bridge'
info['UIApplicationSceneManifest'] = {
  'UIApplicationSupportsMultipleScenes' => false,
  'UISceneConfigurations' => {
    'UIWindowSceneSessionRoleApplication' => [{
      'UISceneConfigurationName' => 'Bridge Sample',
      'UISceneDelegateClassName' => '$(PRODUCT_MODULE_NAME).BridgeSampleSceneDelegate',
      'UISceneStoryboardFile' => 'Main'
    }]
  }
}
Xcodeproj::Plist.write_to_path(info, File.join(sample, 'build/Info-Bridge.plist'))
File.open(report, 'wx') do |out|
  out.write(JSON.pretty_generate({ source: JSON.parse(File.read(File.join(sample, 'source.json'))), files: before.map do |path, bytes|
    { path: path.delete_prefix(upstream + '/'), beforeSha256: Digest::SHA256.hexdigest(bytes), afterSha256: Digest::SHA256.file(path).hexdigest }
  end }) + "\n")
end
puts report
