// Included once by the prepared FBWebServer translation unit. The upstream
// package remains untouched; prepare-ios-wda records every source transformation.
#import "AABWDABinding.m"
#import "FBCommandHandler.h"
#import "FBConfiguration.h"
#import "FBResponseJSONPayload.h"
#import "FBRouteRequest.h"
#import "FBSession.h"
#import "XCUIApplication+FBHelpers.h"
#import "XCUIApplication+FBQuiescence.h"
#import "XCUIApplication.h"

static NSDictionary *AABWDASessionTarget;

static NSDictionary *AABWDAForeground(void)
{
  XCUIApplication *app = XCUIApplication.fb_activeApplication;
  return app.bundleID && app.processID > 0
    ? @{ @"bundleId": app.bundleID, @"processId": @(app.processID) } : @{};
}

static id<FBResponsePayload> AABWDAReject(NSString *code)
{
  return [[FBResponseJSONPayload alloc] initWithDictionary:@{
    @"wdaBinding": AABWDABinding.shared.identity, @"sessionId": NSNull.null,
    @"value": @{ @"error": code, @"message": code, @"dispatched": @NO, @"ambiguous": @NO }
  } httpStatusCode:409];
}

// Called by WDA on its main route queue immediately before mounting the route.
// Session/foreground checks also protect reads: reading a tree cannot launch
// an App, replace a session, or silently observe another foreground process.
static NSString *AABWDAAdmission(FBRoute *route, NSDictionary *headers, NSDictionary *parameters, NSData *body)
{
  NSString *error = [AABWDABinding.shared runtimeErrorForHeaders:headers];
  if (error) return error;
  if (body.length > 4 * 1024 * 1024) return @"ios_wda_request_too_large";
  if (body.length && ![[NSJSONSerialization JSONObjectWithData:body options:0 error:NULL] isKindOfClass:NSDictionary.class])
    return @"invalid_ios_wda_json";
  if ([route.path isEqual:@"/status"] || ([route.path isEqual:@"/aab/session"] && [route.verb isEqual:@"GET"])) return nil;
  if (![route.path hasPrefix:@"/session/:sessionID/"]) return @"ios_wda_route_unsupported";
  FBSession *session = FBSession.activeSession;
  if (!session || !AABWDASessionTarget || ![session.identifier isEqual:AABWDASessionTarget[@"sessionId"]]) return @"ios_wda_session_required";
  if (![parameters[@"sessionID"] isEqual:session.identifier]) return @"ios_wda_session_changed";
  NSDictionary *foreground = AABWDAForeground();
  if (![foreground[@"bundleId"] isEqual:AABWDASessionTarget[@"bundleId"]]
      || ![foreground[@"processId"] isEqual:AABWDASessionTarget[@"processId"]]) return @"ios_wda_target_changed";
  error = [AABWDABinding.shared targetErrorForHeaders:headers actualTarget:foreground sessionId:session.identifier];
  if (error) return error;
  NSSet *allowed = [NSSet setWithArray:@[
    @"GET /session/:sessionID/source", @"POST /session/:sessionID/elements"
  ]];
  return [allowed containsObject:[NSString stringWithFormat:@"%@ %@", route.verb, route.path]] ? nil : @"ios_wda_route_unsupported";
}

@interface AABWDACommands : NSObject <FBCommandHandler>
@end

#import "AABWDAManagedRoutes.h"
@implementation AABWDACommands
+ (NSArray *)routes
{
  return @[
    [[FBRoute GET:@"/aab/session"].withoutSession respondWithTarget:self action:@selector(status:)]
  ];
}
+ (id<FBResponsePayload>)status:(FBRouteRequest *)request
{
  return FBResponseWithObject(@{ @"foreground": AABWDAForeground(), @"session": AABWDASessionTarget ?: NSNull.null });
}
@end
