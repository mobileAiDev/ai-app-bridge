#import "AABWDABinding.h"

@interface AABWDABinding ()
@property(atomic, copy, readwrite) NSDictionary *identity;
@property(atomic, readwrite) BOOL ready;
@property(nonatomic, strong) NSURL *directory;
@end

@implementation AABWDABinding
+ (instancetype)shared
{
  static AABWDABinding *value;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    NSURL *directory = [NSFileManager.defaultManager URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask].firstObject;
    value = [[self alloc] initWithDirectory:directory bundleId:NSBundle.mainBundle.bundleIdentifier
                                 processId:@(NSProcessInfo.processInfo.processIdentifier) runtimeEpoch:NSUUID.UUID.UUIDString];
  });
  return value;
}

- (instancetype)initWithDirectory:(NSURL *)directory bundleId:(NSString *)bundleId
                       processId:(NSNumber *)processId runtimeEpoch:(NSString *)runtimeEpoch
{
  self = [super init];
  if (self) {
    _directory = directory;
    _identity = @{ @"schemaVersion": @"aab.ios-wda/v1", @"bundleId": bundleId,
                   @"runtimeEpoch": runtimeEpoch, @"processId": processId, @"port": @0 };
  }
  return self;
}

- (BOOL)publishPort:(NSUInteger)port error:(NSError **)error
{
  self.ready = NO;
  if (port < 1 || port > 65535) {
    if (error) *error = [NSError errorWithDomain:@"AABWDABinding" code:1 userInfo:@{NSLocalizedDescriptionKey:@"Invalid WDA port"}];
    return NO;
  }
  NSMutableDictionary *identity = self.identity.mutableCopy;
  identity[@"port"] = @(port);
  self.identity = identity.copy;
  NSMutableDictionary *descriptor = identity.mutableCopy;
  descriptor[@"ok"] = @YES;
  NSData *data = [NSJSONSerialization dataWithJSONObject:descriptor options:NSJSONWritingSortedKeys error:error];
  if (!data || ![NSFileManager.defaultManager createDirectoryAtURL:self.directory withIntermediateDirectories:YES attributes:nil error:error]) return NO;
  self.ready = [data writeToURL:[self.directory URLByAppendingPathComponent:@"ai_app_bridge_wda.json"] options:NSDataWritingAtomic error:error];
  return self.ready;
}

- (nullable NSDictionary *)normalizedHeaders:(NSDictionary *)headers
{
  NSMutableDictionary *values = [NSMutableDictionary dictionary];
  for (id key in headers) {
    if (![key isKindOfClass:NSString.class] || ![headers[key] isKindOfClass:NSString.class]) return nil;
    NSString *name = [key lowercaseString];
    if (values[name]) return nil;
    values[name] = headers[key];
  }
  return values.copy;
}

- (nullable NSString *)runtimeErrorForHeaders:(NSDictionary *)headers
{
  if (!self.ready) return @"ios_wda_descriptor_not_ready";
  NSDictionary *values = [self normalizedHeaders:headers];
  if (!values) return @"invalid_ios_wda_headers";
  NSDictionary *identity = self.identity;
  NSDictionary *expected = @{
    @"x-aab-wda-schema": identity[@"schemaVersion"],
    @"x-aab-wda-bundle-id": identity[@"bundleId"],
    @"x-aab-wda-runtime-epoch": identity[@"runtimeEpoch"],
    @"x-aab-wda-process-id": [identity[@"processId"] stringValue],
    @"x-aab-wda-port": [identity[@"port"] stringValue],
  };
  for (NSString *key in expected) {
    if (![values[key] isEqual:expected[key]]) return @"ios_wda_binding_mismatch";
  }
  return nil;
}

- (nullable NSString *)targetErrorForHeaders:(NSDictionary *)headers
                               actualTarget:(NSDictionary *)target sessionId:(nullable NSString *)sessionId
{
  NSDictionary *values = [self normalizedHeaders:headers];
  if (!values) return @"invalid_ios_wda_headers";
  NSString *bundleId = target[@"bundleId"];
  NSNumber *processId = target[@"processId"];
  if (![bundleId isKindOfClass:NSString.class] || !bundleId.length || ![processId isKindOfClass:NSNumber.class] || processId.longLongValue <= 0)
    return @"ios_wda_foreground_unavailable";
  if (![values[@"x-aab-wda-target-bundle-id"] isEqual:bundleId]
      || ![values[@"x-aab-wda-target-process-id"] isEqual:processId.stringValue]) return @"ios_wda_target_changed";
  if (sessionId && ![values[@"x-aab-wda-session-id"] isEqual:sessionId]) return @"ios_wda_session_changed";
  return nil;
}
@end
