// Included by FBWebServer after AABWDAIntegration. Control routes run on each
// HTTP connection's queue; only UI preparation/event submission use main.
#import "AABWDAReceiptStore.m"
#import "AABWDAExecution.m"
#include "sfs.c"
#import "FBW3CActionsSynthesizer.h"
#import "XCUIElement+FBCaching.h"
#import "XCUIElement+FBUtilities.h"
#import "XCUIElement+FBFind.h"
#import "XCUIElement+FBUID.h"
#import "XCUIElement+FBWebDriverAttributes.h"
#import "FBElementTypeTransformer.h"
#import "XCPointerEventPath.h"
#import "XCSynthesizedEventRecord.h"
#import "XCUIDevice.h"
#import "FBXCDeviceEvent.h"
#import "XCTRunnerDaemonSession.h"
#import "XCTestManager_ManagerInterface-Protocol.h"
#import "RoutingHTTPServer.h"
#import "RouteRequest.h"
#import "RouteResponse.h"
#include <math.h>

// WDA 14.1.1 uses this exact event-synthesizer callback (BOOL, NSError *).
// Keep the declaration local instead of borrowing the different daemon API.
@protocol AABWDAEventSynthesizer <NSObject>
- (void)synthesizeEvent:(XCSynthesizedEventRecord *)event completion:(void (^)(BOOL, NSError *))completion;
@end

static AABWDAExecution *AABWDARuntime(void)
{
  static AABWDAExecution *runtime;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    NSURL *directory = [[NSFileManager.defaultManager URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask].firstObject
                       URLByAppendingPathComponent:@"ai_app_bridge_wda_execution"];
    AABWDAReceiptStore *store = [[AABWDAReceiptStore alloc] initWithDirectory:directory runnerBundleId:NSBundle.mainBundle.bundleIdentifier];
    runtime = [[AABWDAExecution alloc] initWithStore:store epoch:AABWDABinding.shared.identity[@"runtimeEpoch"]];
  });
  return runtime;
}

static void AABWDAWire(RouteResponse *response, NSDictionary *value)
{
  [[[FBResponseJSONPayload alloc] initWithDictionary:@{@"wdaBinding": AABWDABinding.shared.identity,
     @"sessionId": NSNull.null, @"value": value} httpStatusCode:200] dispatchWithResponse:response];
}

static NSString *AABWDACheckTarget(AABWDATask *task)
{
  NSDictionary *target = task.target;
  NSString *operation = task.body[@"operation"];
  if ([operation isEqual:@"session-create"]) {
    if (FBSession.activeSession) return @"ios_wda_session_busy";
  } else if (!AABWDASessionTarget || ![FBSession.activeSession.identifier isEqual:target[@"sessionId"]]
             || ![AABWDASessionTarget[@"bundleId"] isEqual:target[@"bundleId"]]
             || ![AABWDASessionTarget[@"processId"] isEqual:target[@"processId"]]) return @"ios_wda_session_changed";
  if ([operation isEqual:@"session-close"]) return nil;
  NSDictionary *actual = AABWDAForeground();
  return [actual[@"bundleId"] isEqual:target[@"bundleId"]] && [actual[@"processId"] isEqual:target[@"processId"]]
    ? nil : @"ios_wda_target_changed";
}

static XCUIElement *AABWDAEditor(AABWDATask *task, BOOL requireFocus);

static BOOL AABWDAIsInput(AABWDATask *task)
{
  return [@[@"input", @"native-input"] containsObject:task.body[@"operation"]];
}

static XCUIElement *AABWDANativeElement(AABWDATask *task, BOOL resolve)
{
  NSDictionary *ref = task.body[@"payload"][@"targetRef"];
  NSString *uid = ref[@"elementId"];
  FBElementCache *cache = FBSession.activeSession.elementCache;
  XCUIElement *element;
  if (resolve) {
    // Match the observed accessibility element identity, never its old position
    // or a new element that happens to have the same label.
    NSPredicate *predicate = [NSPredicate predicateWithFormat:@"UID == %@", uid];
    NSArray<XCUIElement *> *matches = [XCUIApplication.fb_activeApplication
      fb_descendantsMatchingPredicate:predicate shouldReturnAfterFirstMatch:NO];
    if (matches.count != 1) return nil;
    element = matches.firstObject;
    if (![[cache storeElement:element] isEqual:uid]) return nil;
  } else {
    element = [cache elementForUUID:uid checkStaleness:YES];
  }
  FBXCElementSnapshotWrapper *snapshot = [FBXCElementSnapshotWrapper ensureWrapped:[element fb_standardSnapshot]];
  NSString *identifier = snapshot.identifier;
  id actualIdentifier = identifier.length ? identifier : NSNull.null;
  return [snapshot.wdUID isEqual:uid] && [actualIdentifier isEqual:ref[@"identifier"]]
    && [(snapshot.wdLabel ?: NSNull.null) isEqual:ref[@"label"]]
    && [[FBElementTypeTransformer shortStringWithElementType:snapshot.elementType] isEqual:ref[@"type"]]
    && snapshot.isWDEnabled && snapshot.isWDVisible ? element : nil;
}

static void AABWDAEvent(AABWDATask *task, XCSynthesizedEventRecord *event, BOOL keyboard, dispatch_block_t completed)
{
  NSString *error = AABWDACheckTarget(task);
  id<AABWDAEventSynthesizer> synthesizer = [XCUIDevice.sharedDevice eventSynthesizer];
  if (![synthesizer respondsToSelector:@selector(synthesizeEvent:completion:)]) error = @"ios_wda_event_api_unavailable";
  if (!error && task.body[@"payload"][@"targetRef"] && !AABWDANativeElement(task, NO)) error = @"ios_native_target_changed";
  if (!error && AABWDAIsInput(task) && !AABWDAEditor(task, keyboard))
    error = @"ios_wda_input_target_changed";
  if (!error) error = [task permission];
  if (error) { [task finish:AABWDAFailure(error)]; return; }
  @try {
    [synthesizer synthesizeEvent:event completion:^(BOOL succeeded, NSError *failure) {
      dispatch_async(dispatch_get_main_queue(), ^{
        if (!succeeded || failure) { [task finish:AABWDAFailure(@"ios_wda_event_failed")]; return; }
        @try { completed(); }
        @catch (NSException *exception) { [task finish:AABWDAFailure(@"ios_wda_postcondition_failed")]; }
      });
    }];
  } @catch (NSException *exception) {
    // An exception after handing the event to XCTest is not an end callback.
    [task unresolved:@"ios_wda_event_submission_unknown"];
  }
}

static XCSynthesizedEventRecord *AABWDAPointer(NSArray *actions, NSError **error)
{
  FBW3CActionsSynthesizer *builder = [[FBW3CActionsSynthesizer alloc] initWithActions:@[
    @{@"type": @"pointer", @"id": @"aab-pointer", @"parameters": @{@"pointerType": @"touch"}, @"actions": actions}
  ] forApplication:XCUIApplication.fb_activeApplication elementCache:FBSession.activeSession.elementCache error:error];
  return builder ? [builder synthesizeWithError:error] : nil;
}

static XCUIElement *AABWDAEditor(AABWDATask *task, BOOL requireFocus)
{
  NSDictionary *payload = task.body[@"payload"];
  NSString *elementId = [task.body[@"operation"] isEqual:@"native-input"] ? payload[@"targetRef"][@"elementId"] : payload[@"elementId"];
  XCUIElement *element = [FBSession.activeSession.elementCache elementForUUID:elementId checkStaleness:YES];
  if (payload[@"targetRef"] && !AABWDANativeElement(task, NO)) return nil;
  id<FBXCElementSnapshot> snapshot = [element fb_standardSnapshot];
  XCUIElementType type = snapshot.elementType;
  if (![element exists] || !snapshot || (type != XCUIElementTypeTextField && type != XCUIElementTypeSecureTextField
      && type != XCUIElementTypeTextView && type != XCUIElementTypeSearchField)) return nil;
  if (requireFocus && !snapshot.hasKeyboardFocus) return nil;
  return element;
}

static void AABWDAClear(AABWDATask *task, dispatch_block_t completed)
{
  NSError *preparation;
  // The iPhone supports the same keyboard-clear HID event used by upstream
  // WDA. Submit once through the daemon's original NSError completion instead
  // of assuming a desktop Command-A shortcut changed the editor.
  id event = FBCreateXCDeviceEvent(0x07, 0x9c, 0.01, &preparation);
  id<XCTestManager_ManagerInterface> daemon = XCTRunnerDaemonSession.sharedSession.daemonProxy;
  NSString *error = AABWDACheckTarget(task);
  if (!error && !AABWDAEditor(task, YES)) error = @"ios_wda_input_target_changed";
  if (!error && (!event || ![(id)daemon respondsToSelector:@selector(_XCT_performDeviceEvent:completion:)]))
    error = @"ios_wda_clear_api_unavailable";
  if (!error) error = [task permission];
  if (error) { [task finish:AABWDAFailure(error)]; return; }
  @try {
    [daemon _XCT_performDeviceEvent:event completion:^(NSError *failure) {
      dispatch_async(dispatch_get_main_queue(), ^{
        if (failure) { [task finish:AABWDAFailure(@"ios_wda_clear_event_failed")]; return; }
        @try { completed(); }
        @catch (NSException *exception) { [task finish:AABWDAFailure(@"ios_wda_postcondition_failed")]; }
      });
    }];
  } @catch (NSException *exception) {
    [task unresolved:@"ios_wda_clear_submission_unknown"];
  }
}

static void AABWDAInput(AABWDATask *task, BOOL clear)
{
  if (AABWDACheckTarget(task) || !AABWDAEditor(task, YES)) { [task finish:AABWDAFailure(@"ios_wda_input_target_changed")]; return; }
  NSDictionary *payload = task.body[@"payload"];
  NSString *text = payload[@"text"];
  if (!clear && text.length == 0) { [task finish:@{@"ok": @YES, @"value": @{@"textLength": @0, @"cleared": payload[@"clearFirst"]}}]; return; }
  if (clear) {
    AABWDAClear(task, ^{
      XCUIElement *current = AABWDAEditor(task, YES);
      if (AABWDACheckTarget(task) || !current) { [task finish:AABWDAFailure(@"ios_wda_input_target_changed")]; return; }
      id value = [current fb_standardSnapshot].value;
      // XCTest represents an empty editor as nil or an empty string. WDA's
      // displayed value may instead contain its placeholder; use the raw value.
      if (value != nil && (![value isKindOfClass:NSString.class] || [value length] != 0)) {
        [task finish:AABWDAFailure(@"ios_wda_clear_not_observed")]; return;
      }
      AABWDAInput(task, NO);
    });
    return;
  }
  XCSynthesizedEventRecord *event = [[XCSynthesizedEventRecord alloc] initWithName:@"Bridge input text"];
  XCPointerEventPath *keys = [[XCPointerEventPath alloc] initForTextInput];
  [keys typeText:text atOffset:0 typingSpeed:FBConfiguration.maxTypingFrequency shouldRedact:YES];
  [event addPointerEventPath:keys];
  AABWDAEvent(task, event, YES, ^{
    if (AABWDACheckTarget(task) || !AABWDAEditor(task, YES)) { [task finish:AABWDAFailure(@"ios_wda_input_target_changed")]; return; }
    [task finish:@{@"ok": @YES, @"value": @{@"textLength": @(text.length), @"cleared": payload[@"clearFirst"]}}];
  });
}

static NSDictionary *AABWDAInterfaceOrientations(void)
{
  return @{@"portrait": @(UIInterfaceOrientationPortrait), @"landscapeLeft": @(UIInterfaceOrientationLandscapeLeft),
    @"landscapeRight": @(UIInterfaceOrientationLandscapeRight), @"portraitUpsideDown": @(UIInterfaceOrientationPortraitUpsideDown)};
}

static void AABWDASetOrientation(AABWDATask *task)
{
  NSString *requested = task.body[@"payload"][@"orientation"];
  UIInterfaceOrientation expected = [AABWDAInterfaceOrientations()[requested] integerValue];
  // UIKit's landscape interface direction is opposite to device orientation.
  UIDeviceOrientation deviceOrientation = expected == UIInterfaceOrientationLandscapeLeft ? UIDeviceOrientationLandscapeRight
    : expected == UIInterfaceOrientationLandscapeRight ? UIDeviceOrientationLandscapeLeft : (UIDeviceOrientation)expected;
  id<XCTestManager_ManagerInterface> daemon = XCTRunnerDaemonSession.sharedSession.daemonProxy;
  NSString *error = AABWDACheckTarget(task);
  if (!error && ![(id)daemon respondsToSelector:@selector(_XCT_updateDeviceOrientation:completion:)])
    error = @"ios_wda_orientation_api_unavailable";
  if (!error) error = [task permission];
  if (error) { [task finish:AABWDAFailure(error)]; return; }
  @try {
    [daemon _XCT_updateDeviceOrientation:deviceOrientation completion:^(NSError *failure) {
      dispatch_async(dispatch_get_main_queue(), ^{
        if (failure) { [task finish:AABWDAFailure(@"ios_wda_orientation_event_failed")]; return; }
        @try {
          NSString *changed = AABWDACheckTarget(task);
          if (changed) { [task finish:AABWDAFailure(changed)]; return; }
          UIInterfaceOrientation actual = XCUIApplication.fb_activeApplication.interfaceOrientation;
          id observed = [AABWDAInterfaceOrientations() allKeysForObject:@(actual)].firstObject ?: NSNull.null;
          NSDictionary *value = @{@"requestedOrientation": requested, @"observedInterfaceOrientation": observed};
          [task finish:actual == expected ? @{@"ok": @YES, @"value": value}
            : @{@"ok": @NO, @"error": @"ios_wda_orientation_not_observed", @"value": value}];
        } @catch (NSException *exception) {
          [task finish:AABWDAFailure(@"ios_wda_orientation_observation_failed")];
        }
      });
    }];
  } @catch (NSException *exception) {
    [task unresolved:@"ios_wda_orientation_submission_unknown"];
  }
}

static void AABWDAStartTask(AABWDATask *task)
{
  @try {
    NSString *error = AABWDACheckTarget(task);
    if (error) { [task finish:AABWDAFailure(error)]; return; }
    NSString *operation = task.body[@"operation"];
    NSDictionary *payload = task.body[@"payload"];
    if ([operation isEqual:@"session-create"] || [operation isEqual:@"session-close"]) {
      error = [task permission];
      if (error) { [task finish:AABWDAFailure(error)]; return; }
      [FBConfiguration setShouldTerminateApp:NO];
      if ([operation isEqual:@"session-close"]) {
        [FBSession.activeSession kill]; AABWDASessionTarget = nil;
        [task finish:@{@"ok": @YES, @"value": NSNull.null}]; return;
      }
      XCUIApplication *app = XCUIApplication.fb_activeApplication;
      if (![app.bundleID isEqual:task.target[@"bundleId"]] || app.processID != [task.target[@"processId"] intValue]) {
        [task finish:AABWDAFailure(@"ios_wda_target_changed")]; return;
      }
      app.fb_shouldWaitForQuiescence = NO;
      FBSession *session = [FBSession initWithApplication:app]; session.defaultActiveApplication = app.bundleID;
      AABWDASessionTarget = @{@"sessionId": session.identifier, @"bundleId": app.bundleID, @"processId": @(app.processID)};
      [task finish:@{@"ok": @YES, @"value": AABWDASessionTarget}]; return;
    }
    if ([operation isEqual:@"set-orientation"]) { AABWDASetOrientation(task); return; }
    NSArray *actions;
    if (payload[@"targetRef"] && !AABWDANativeElement(task, YES)) { [task finish:AABWDAFailure(@"ios_native_target_changed")]; return; }
    if (AABWDAIsInput(task) || [operation isEqual:@"native-tap"]) {
      if (AABWDAIsInput(task) && !AABWDAEditor(task, NO)) { [task finish:AABWDAFailure(@"ios_wda_input_target_changed")]; return; }
      NSString *elementId = payload[@"targetRef"] ? payload[@"targetRef"][@"elementId"] : payload[@"elementId"];
      actions = @[
        @{@"type": @"pointerMove", @"duration": @0, @"x": @0, @"y": @0,
          @"origin": @{@"element-6066-11e4-a52e-4f735466cecf": elementId}},
        @{@"type": @"pointerDown", @"button": @0}, @{@"type": @"pointerUp", @"button": @0}
      ];
    } else if ([operation isEqual:@"tap"]) {
      actions = @[@{@"type": @"pointerMove", @"duration": @0, @"x": payload[@"x"], @"y": payload[@"y"]},
                  @{@"type": @"pointerDown", @"button": @0}, @{@"type": @"pointerUp", @"button": @0}];
    } else {
      actions = @[
        @{@"type": @"pointerMove", @"duration": @0, @"x": payload[@"startX"], @"y": payload[@"startY"]},
        @{@"type": @"pointerDown", @"button": @0},
        @{@"type": @"pointerMove", @"duration": payload[@"durationMs"], @"x": payload[@"endX"], @"y": payload[@"endY"]},
        @{@"type": @"pointerUp", @"button": @0}
      ];
    }
    NSError *preparation;
    XCSynthesizedEventRecord *event = AABWDAPointer(actions, &preparation);
    if (!event) { [task finish:AABWDAFailure(@"ios_wda_event_preparation_failed")]; return; }
    AABWDAEvent(task, event, NO, ^{
      if (AABWDAIsInput(task)) AABWDAInput(task, [payload[@"clearFirst"] boolValue]);
      else [task finish:@{@"ok": @YES, @"value": NSNull.null}];
    });
  } @catch (NSException *exception) {
    [task finish:AABWDAFailure(@"ios_wda_target_unavailable")];
  }
}

static NSString *AABWDAValidateBody(NSDictionary *body, NSDictionary *headers)
{
  if (![[NSSet setWithArray:body.allKeys] isEqual:[NSSet setWithArray:@[@"operation", @"target", @"payload", @"actionId", @"execution"]]])
    return @"invalid_ios_wda_action";
  NSString *operation = body[@"operation"];
  NSDictionary *target = body[@"target"], *payload = body[@"payload"];
  NSDictionary *fields = @{@"tap": @[@"x", @"y"], @"swipe": @[@"startX", @"startY", @"endX", @"endY", @"durationMs"],
    @"input": @[@"elementId", @"text", @"clearFirst"], @"session-create": @[], @"session-close": @[],
    @"native-tap": @[@"targetRef"], @"native-input": @[@"targetRef", @"text", @"clearFirst"],
    @"set-orientation": @[@"orientation"]};
  if (![operation isKindOfClass:NSString.class] || !fields[operation] || ![target isKindOfClass:NSDictionary.class]
      || ![payload isKindOfClass:NSDictionary.class]) return @"invalid_ios_wda_action";
  NSArray *targetFields = [operation isEqual:@"session-create"] ? @[@"bundleId", @"processId"] : @[@"bundleId", @"processId", @"sessionId"];
  if (![[NSSet setWithArray:target.allKeys] isEqual:[NSSet setWithArray:targetFields]] || !AABWDAText(target[@"bundleId"])
      || !AABWDAInteger(target[@"processId"], 1, INT32_MAX)
      || (targetFields.count == 3 && !AABWDAText(target[@"sessionId"]))
      || ![[NSSet setWithArray:payload.allKeys] isEqual:[NSSet setWithArray:fields[operation]]]) return @"invalid_ios_wda_action";
  if ([operation hasPrefix:@"native-"]) {
    NSDictionary *ref = payload[@"targetRef"];
    if (![ref isKindOfClass:NSDictionary.class]
        || ![[NSSet setWithArray:ref.allKeys] isEqual:[NSSet setWithArray:@[@"elementId", @"type", @"identifier", @"label"]]]
        || !AABWDAText(ref[@"elementId"]) || !AABWDAText(ref[@"type"])) return @"invalid_ios_native_target";
    for (NSString *name in @[@"identifier", @"label"]) {
      if (ref[name] != NSNull.null && (![ref[name] isKindOfClass:NSString.class] || [ref[name] length] > 16384))
        return @"invalid_ios_native_target";
    }
  }
  if ([operation isEqual:@"set-orientation"]) {
    if (![payload[@"orientation"] isKindOfClass:NSString.class] || !AABWDAInterfaceOrientations()[payload[@"orientation"]])
      return @"invalid_ios_wda_orientation";
  } else if ([operation isEqual:@"input"] || [operation isEqual:@"native-input"]) {
    if (([operation isEqual:@"input"] && !AABWDAText(payload[@"elementId"])) || ![payload[@"text"] isKindOfClass:NSString.class]
        || [payload[@"text"] lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 64 * 1024
        || ![payload[@"clearFirst"] isKindOfClass:NSNumber.class]
        || CFGetTypeID((__bridge CFTypeRef)payload[@"clearFirst"]) != CFBooleanGetTypeID()) return @"invalid_ios_wda_input";
  } else for (NSString *field in fields[operation]) {
    if ([field isEqual:@"targetRef"]) continue;
    id value = payload[field];
    if ([field isEqual:@"durationMs"]) { if (!AABWDAInteger(value, 1, 120000)) return @"invalid_ios_wda_duration"; }
    else if (![value isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()
          || !isfinite([value doubleValue]) || [value doubleValue] < 0 || [value doubleValue] > 100000) return @"invalid_ios_wda_coordinate";
  }
  return [AABWDABinding.shared targetErrorForHeaders:headers actualTarget:target sessionId:target[@"sessionId"]];
}

static void AABWDARegisterControl(RoutingHTTPServer *server)
{
  for (NSString *route in @[@"/aab/status", @"/aab/execution/result", @"/aab/execution/cancel", @"/aab/action"]) {
    NSString *method = [route isEqual:@"/aab/action"] || [route hasSuffix:@"/cancel"] ? @"POST" : @"GET";
    [server handleMethod:method withPath:route block:^(RouteRequest *request, RouteResponse *response) {
      NSString *bindingError = [AABWDABinding.shared runtimeErrorForHeaders:request.headers];
      if (bindingError) { [AABWDAReject(bindingError) dispatchWithResponse:response]; return; }
      if ([route isEqual:@"/aab/status"]) {
        NSMutableDictionary *status = [[AABWDARuntime() status] mutableCopy];
        status[@"nativeTargetSchema"] = @"aab.ios-native-target/v1";
        status[@"orientationSchema"] = @"aab.ios-orientation/v1";
        AABWDAWire(response, status); return;
      }
      NSDictionary *body;
      if ([method isEqual:@"POST"]) {
        body = request.body.length <= 256 * 1024 ? [NSJSONSerialization JSONObjectWithData:request.body options:0 error:NULL] : nil;
      } else {
        NSMutableDictionary *parameters = [NSMutableDictionary dictionary];
        for (NSURLQueryItem *item in [NSURLComponents componentsWithURL:request.url resolvingAgainstBaseURL:NO].queryItems) {
          if (parameters[item.name] || !item.value) { AABWDAWire(response, AABWDAFailure(@"invalid_ios_wda_query")); return; }
          parameters[item.name] = item.value;
        }
        body = parameters;
      }
      if (![body isKindOfClass:NSDictionary.class]) { AABWDAWire(response, AABWDAFailure(@"invalid_ios_wda_json")); return; }
      if ([route isEqual:@"/aab/action"]) {
        NSString *error = AABWDAValidateBody(body, request.headers);
        if (error) { AABWDAWire(response, AABWDAFailure(error)); return; }
        NSMutableDictionary *target = [body[@"target"] mutableCopy];
        target[@"runnerBundleId"] = AABWDABinding.shared.identity[@"bundleId"]; target[@"operation"] = body[@"operation"];
        dispatch_semaphore_t finished = dispatch_semaphore_create(0);
        __block NSDictionary *result;
        [AABWDARuntime() submit:body target:target start:^(AABWDATask *task) { AABWDAStartTask(task); }
          reply:^(NSDictionary *value) { result = value; dispatch_semaphore_signal(finished); }];
        dispatch_semaphore_wait(finished, DISPATCH_TIME_FOREVER);
        AABWDAWire(response, result); return;
      }
      NSSet *allowed = [NSSet setWithArray:[method isEqual:@"GET"] ? @[@"actionId", @"runtimeEpoch", @"cursor"] : @[@"actionId", @"runtimeEpoch"]];
      if (![[NSSet setWithArray:body.allKeys] isSubsetOfSet:allowed] || !AABWDAText(body[@"actionId"]) || !AABWDAText(body[@"runtimeEpoch"])
          || (body[@"cursor"] && (![body[@"cursor"] isKindOfClass:NSString.class] || [body[@"cursor"] length] > 2048))) {
        AABWDAWire(response, AABWDAFailure(@"invalid_ios_wda_query")); return;
      }
      AABWDAWire(response, [method isEqual:@"GET"]
        ? [AABWDARuntime() result:body[@"actionId"] epoch:body[@"runtimeEpoch"] cursor:body[@"cursor"]]
        : [AABWDARuntime() cancel:body[@"actionId"] epoch:body[@"runtimeEpoch"]]);
    }];
  }
}
