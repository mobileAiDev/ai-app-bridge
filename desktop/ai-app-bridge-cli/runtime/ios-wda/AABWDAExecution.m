#import "AABWDAExecution.h"

static NSString *const AABWDASchema = @"aab.wda-execution/v1";
static NSDictionary *AABWDAFailure(NSString *code)
{
  return @{@"ok": @NO, @"error": code, @"dispatched": @NO, @"ambiguous": @NO};
}
static BOOL AABWDAText(id value)
{
  return [value isKindOfClass:NSString.class] && [value length] > 0 && [value lengthOfBytesUsingEncoding:NSUTF8StringEncoding] <= 256;
}

@interface AABWDATask ()
@property(nonatomic, copy, readwrite) NSDictionary *body;
@property(nonatomic, copy, readwrite) NSDictionary *target;
@property(nonatomic, weak) AABWDAExecution *owner;
@property(nonatomic, copy) NSDictionary *identity;
@property(nonatomic) NSTimeInterval deadline;
@property(nonatomic) BOOL issued;
@property(nonatomic, copy, nullable) NSString *stopReason;
@property(nonatomic, copy, nullable) NSDictionary *candidate;
@property(nonatomic, copy, nullable) AABWDAReply reply;
@end

@interface AABWDAExecution ()
- (nullable NSString *)permission:(AABWDATask *)task;
- (void)finish:(AABWDATask *)task outcome:(NSDictionary *)outcome;
- (void)stop:(AABWDATask *)task reason:(NSString *)reason;
@end
@implementation AABWDATask
- (NSString *)permission { return self.owner ? [self.owner permission:self] : @"ios_wda_action_not_active"; }
- (void)finish:(NSDictionary *)outcome { [self.owner finish:self outcome:outcome]; }
- (void)unresolved:(NSString *)reason { AABWDAExecution *owner = self.owner; @synchronized (owner) { [owner stop:self reason:reason]; } }
@end

@implementation AABWDAExecution {
  AABWDAReceiptStore *_store;
  NSString *_epoch;
  AABWDATask *_active;
  NSString *_lastId;
}
- (instancetype)initWithStore:(AABWDAReceiptStore *)store epoch:(NSString *)epoch
{
  self = [super init];
  if (self) { _store = store; _epoch = epoch.copy; }
  return self;
}
- (NSDictionary *)pending:(AABWDATask *)task code:(NSString *)code
{
  NSMutableDictionary *result = task.identity.mutableCopy;
  [result addEntriesFromDictionary:@{@"ok": @NO, @"error": code, @"settled": @NO, @"dispatched": NSNull.null, @"ambiguous": @YES}];
  return result;
}
- (void)reply:(AABWDATask *)task value:(NSDictionary *)value
{
  AABWDAReply reply = task.reply; task.reply = nil;
  // Response serialization can never block the execution lock or re-enter it.
  if (reply) dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{ reply(value); });
}
- (void)persist:(AABWDATask *)task
{
  if (_active != task || !task.candidate) return;
  NSDictionary *receipt = [_store commit:task.candidate];
  if (!receipt) { [self reply:task value:[self pending:task code:@"ios_wda_completion_store_unavailable"]]; return; }
  _lastId = task.identity[@"actionId"]; _active = nil;
  [self reply:task value:task.candidate];
}
- (void)stop:(AABWDATask *)task reason:(NSString *)reason
{
  if (_active != task) return;
  if (task.candidate) { [self persist:task]; return; }
  if (task.stopReason) return;
  task.stopReason = reason;
  if (!task.issued) {
    [self finish:task outcome:AABWDAFailure(task.stopReason)];
  } else {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 1500 * NSEC_PER_MSEC), dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
      @synchronized (self) { if (self->_active == task) [self reply:task value:[self pending:task code:task.stopReason]]; }
    });
  }
}
- (void)submit:(NSDictionary *)body target:(NSDictionary *)target start:(AABWDAStart)start reply:(AABWDAReply)reply
{
  @synchronized (self) {
    NSDictionary *execution = body[@"execution"];
    id timeout = [execution isKindOfClass:NSDictionary.class] ? execution[@"timeoutMs"] : nil;
    NSSet *fields = [NSSet setWithArray:@[@"schemaVersion", @"actionId", @"runtimeEpoch", @"timeoutMs"]];
    if (![execution isKindOfClass:NSDictionary.class] || ![[NSSet setWithArray:execution.allKeys] isEqual:fields]
        || ![execution[@"schemaVersion"] isEqual:AABWDASchema] || !AABWDAText(execution[@"actionId"])
        || ![body[@"actionId"] isEqual:execution[@"actionId"]] || ![execution[@"runtimeEpoch"] isEqual:_epoch]
        || ![timeout isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)timeout) == CFBooleanGetTypeID()
        || [timeout doubleValue] != [timeout longLongValue] || [timeout longLongValue] < 1 || [timeout longLongValue] > INT32_MAX) {
      reply(AABWDAFailure(@"invalid_ios_wda_execution")); return;
    }
    if (!_store.ready) { reply(AABWDAFailure(@"ios_wda_completion_store_unavailable")); return; }
    if (_active) { reply(AABWDAFailure(@"ios_wda_action_busy")); return; }
    if ([_lastId isEqual:execution[@"actionId"]]) { reply(AABWDAFailure(@"ios_wda_action_id_reused")); return; }
    AABWDATask *task = [AABWDATask new];
    task.owner = self; task.body = body.copy; task.target = target.copy; task.reply = reply;
    task.deadline = NSProcessInfo.processInfo.systemUptime + [timeout doubleValue] / 1000;
    task.identity = @{@"schemaVersion": AABWDASchema, @"actionId": execution[@"actionId"], @"runtimeEpoch": _epoch};
    _active = task;
    __weak AABWDATask *weakTask = task;
    __weak AABWDAExecution *weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, [timeout longLongValue] * NSEC_PER_MSEC), dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
      AABWDAExecution *owner = weakSelf; AABWDATask *pending = weakTask;
      if (owner && pending) @synchronized (owner) { [owner stop:pending reason:@"ios_wda_action_timeout"]; }
    });
    dispatch_async(dispatch_get_main_queue(), ^{
      @synchronized (self) { if (self->_active != task || task.candidate || task.stopReason) return; }
      start(task);
    });
  }
}
- (NSString *)permission:(AABWDATask *)task
{
  @synchronized (self) {
    if (_active != task || task.candidate) return @"ios_wda_action_not_active";
    if (NSProcessInfo.processInfo.systemUptime >= task.deadline) [self stop:task reason:@"ios_wda_action_timeout"];
    if (_active != task || task.stopReason) return task.stopReason ?: @"ios_wda_action_not_active";
    task.issued = YES;
    return nil;
  }
}
- (void)finish:(AABWDATask *)task outcome:(NSDictionary *)outcome
{
  @synchronized (self) {
    if (_active != task || task.candidate) return;
    if (![outcome[@"ok"] isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)outcome[@"ok"]) != CFBooleanGetTypeID()
        || (![outcome[@"ok"] boolValue] && !AABWDAText(outcome[@"error"]))) return;
    NSMutableDictionary *result = outcome.mutableCopy;
    if (task.stopReason) { result[@"ok"] = @NO; result[@"error"] = task.stopReason; }
    result[@"actionId"] = task.identity[@"actionId"]; result[@"runtimeEpoch"] = _epoch;
    result[@"settled"] = @YES; result[@"dispatched"] = @(task.issued); result[@"ambiguous"] = @NO;
    NSMutableDictionary *execution = task.identity.mutableCopy;
    execution[@"settled"] = @YES; execution[@"target"] = task.target;
    result[@"execution"] = execution;
    NSData *bytes = [NSJSONSerialization isValidJSONObject:result]
      ? [NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingSortedKeys error:NULL] : nil;
    if (!bytes || bytes.length > 64 * 1024) {
      result = [@{@"ok": @NO, @"error": @"ios_wda_invalid_result", @"execution": execution,
        @"actionId": task.identity[@"actionId"], @"runtimeEpoch": _epoch, @"settled": @YES,
        @"dispatched": @(task.issued), @"ambiguous": @NO} mutableCopy];
    }
    task.candidate = result.copy;
    [self persist:task];
  }
}
- (NSDictionary *)cancel:(NSString *)actionId epoch:(NSString *)epoch
{
  @synchronized (self) {
    AABWDATask *task = _active;
    if (task && [task.identity[@"actionId"] isEqual:actionId] && [task.identity[@"runtimeEpoch"] isEqual:epoch]) {
      [self stop:task reason:@"ios_wda_action_cancelled"];
      if (_active == task) return [self pending:task code:@"ios_wda_action_cancel_pending"];
    }
    return [_store lookupAction:actionId epoch:epoch cursor:nil];
  }
}
- (NSDictionary *)result:(NSString *)actionId epoch:(NSString *)epoch cursor:(NSString *)cursor
{
  return [_store lookupAction:actionId epoch:epoch cursor:cursor];
}
- (NSDictionary *)status
{
  @synchronized (self) {
    return @{@"ok": @YES, @"executionSchema": AABWDASchema, @"ready": @(_store.ready),
      @"active": _active ? @{@"identity": _active.identity, @"target": _active.target, @"permissionIssued": @(_active.issued),
          @"persistencePending": @(_active.candidate != nil), @"stopReason": _active.stopReason ?: NSNull.null} : NSNull.null};
  }
}
@end
