'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { CommandError } = require('./command-errors');

const supportedVersion = '14.1.1';
const directories = ['Configurations', 'PrivateHeaders', 'Scripts', 'WebDriverAgentLib', 'WebDriverAgentRunner', 'WebDriverAgentTests', 'WebDriverAgent.xcodeproj'];

function wdaBuildEnvironment(environment = process.env) {
  const result = { ...environment };
  // A device build must use Xcode's selected SDK, never injected macOS
  // header/library search paths from the Host shell.
  for (const name of ['CPATH', 'C_INCLUDE_PATH', 'CPLUS_INCLUDE_PATH', 'OBJC_INCLUDE_PATH', 'LIBRARY_PATH', 'SDKROOT']) delete result[name];
  return result;
}

function replaceOnce(source, before, after, file) {
  if (source.split(before).length !== 2) throw new CommandError('ios_wda_source_mismatch', `The pinned WDA integration point changed: ${file}.`);
  return source.replace(before, after);
}

function prepareWdaProject({ destination, packageDirectory = path.dirname(require.resolve('appium-webdriveragent/package.json')) }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'));
  if (manifest.version !== supportedVersion) throw new CommandError('ios_wda_version_unsupported', `The prepared WDA runtime requires appium-webdriveragent ${supportedVersion}.`);
  fs.mkdirSync(destination, { recursive: true });
  if (fs.readdirSync(destination).length) throw new CommandError('ios_wda_destination_not_empty', 'WDA preparation requires an empty destination.');
  for (const name of directories) fs.cpSync(path.join(packageDirectory, name), path.join(destination, name), { recursive: true });
  fs.copyFileSync(path.join(packageDirectory, 'LICENSE'), path.join(destination, 'LICENSE.upstream'));
  const sourceRoot = path.join(__dirname, '..', 'runtime', 'ios-wda');
  for (const name of ['AABWDABinding.h', 'AABWDABinding.m', 'AABWDAIntegration.h', 'AABWDAManagedRoutes.h',
    'AABWDAReceiptStore.h', 'AABWDAReceiptStore.m', 'AABWDAExecution.h', 'AABWDAExecution.m']) {
    fs.copyFileSync(path.join(sourceRoot, name), path.join(destination, 'WebDriverAgentLib', 'Routing', name));
  }
  const nativeRoot = path.dirname(require.resolve('@mobileaidev/segmented-fact-store-native/package.json'));
  const nativeCore = { version: JSON.parse(fs.readFileSync(path.join(nativeRoot, 'package.json'))).version, files: [] };
  for (const relative of ['include/sfs.h', 'src/sfs.c']) {
    const bytes = fs.readFileSync(path.join(nativeRoot, relative));
    fs.writeFileSync(path.join(destination, 'WebDriverAgentLib', 'Routing', path.basename(relative)), bytes);
    nativeCore.files.push({ path: relative, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const transformations = [];
  function patch(relative, edits) {
    const filename = path.join(destination, relative);
    const original = fs.readFileSync(filename, 'utf8');
    let content = original;
    for (const [before, after] of edits) content = replaceOnce(content, before, after, relative);
    fs.writeFileSync(filename, content);
    const digest = value => createHash('sha256').update(value).digest('hex');
    transformations.push({ path: relative, beforeSha256: digest(original), afterSha256: digest(content) });
  }
  patch('WebDriverAgentLib/Routing/FBWebServer.m', [
    ['#import "XCUIDevice+FBHelpers.h"', '#import "XCUIDevice+FBHelpers.h"\n#import "AABWDAIntegration.h"'],
    ['[self.server setRouteQueue:dispatch_get_main_queue()];', '[self.server setRouteQueue:nil];'],
    ['  [self registerRouteHandlers:[self.class collectCommandHandlerClasses]];', '  AABWDARegisterControl(self.server);\n  [self registerRouteHandlers:[self.class collectCommandHandlerClasses]];'],
    ['  NSString *serverHost = bindingIP', '  NSError *bindingError;\n  if (![AABWDABinding.shared publishPort:self.server.port error:&bindingError]) {\n    [FBLogger logFmt:@"AAB WDA descriptor publication failed: %@", bindingError];\n  }\n\n  NSString *serverHost = bindingIP'],
    ['        NSDictionary *arguments = [NSJSONSerialization JSONObjectWithData:request.body',
      '        dispatch_sync(dispatch_get_main_queue(), ^{\n        NSString *admissionError = AABWDAAdmission(route, request.headers, request.params, request.body);\n        if (admissionError) { [AABWDAReject(admissionError) dispatchWithResponse:response]; return; }\n        NSDictionary *arguments = [NSJSONSerialization JSONObjectWithData:request.body'],
    ['          [strongSelf handleException:exception forResponse:response];\n        }\n      }];',
      '          [strongSelf handleException:exception forResponse:response];\n        }\n        });\n      }];'],
    ['    [response respondWithString:@"Shutting down"];\n    [strongSelf.delegate webServerDidRequestShutdown:strongSelf];',
      '    [AABWDAReject(@"ios_wda_route_unsupported") dispatchWithResponse:response];'],
  ]);
  patch('WebDriverAgentLib/Routing/FBResponsePayload.m', [
    ['#import "FBResponsePayload.h"', '#import "FBResponsePayload.h"\n#import "AABWDABinding.h"'],
    ['  response[@"sessionId"] = [FBSession activeSession].identifier ?: NSNull.null;', '  response[@"wdaBinding"] = AABWDABinding.shared.identity;\n  response[@"sessionId"] = [FBSession activeSession].identifier ?: NSNull.null;'],
  ]);
  patch('WebDriverAgentLib/Categories/XCUIApplication+FBHelpers.m', [
    ['\n  info[@"rawIdentifier"] = FBValueOrNull([snapshot.identifier isEqual:@""] ? nil : snapshot.identifier);',
      '\n  info[@"rawIdentifier"] = FBValueOrNull([snapshot.identifier isEqual:@""] ? nil : snapshot.identifier);\n  info[@"elementId"] = FBValueOrNull([FBXCElementSnapshotWrapper ensureWrapped:snapshot].wdUID);'],
  ]);
  const result = { schemaVersion: 'aab.ios-wda-project/v1', upstreamVersion: supportedVersion,
    projectPath: path.join(destination, 'WebDriverAgent.xcodeproj'), transformations, nativeCore };
  fs.writeFileSync(path.join(destination, 'aab-wda-project.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

module.exports = { supportedVersion, prepareWdaProject, wdaBuildEnvironment };
