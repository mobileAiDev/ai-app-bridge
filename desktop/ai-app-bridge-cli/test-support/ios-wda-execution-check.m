#import <Foundation/Foundation.h>
#import "AABWDAExecution.h"

static void Require(BOOL condition, NSString *message)
{
  if (!condition) { fprintf(stderr, "%s\n", message.UTF8String); exit(1); }
}
static void Until(BOOL (^ready)(void))
{
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:5];
  while (!ready() && deadline.timeIntervalSinceNow > 0)
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.005]];
  Require(ready(), @"timed out waiting for actual callback");
}
static NSDictionary *Body(NSString *actionId, NSUInteger timeout)
{
  return @{@"actionId": actionId, @"execution": @{@"schemaVersion": @"aab.wda-execution/v1", @"actionId": actionId,
          @"runtimeEpoch": @"original-runner", @"timeoutMs": @(timeout)}};
}
static NSDictionary *Target(void)
{
  return @{@"runnerBundleId": @"test.runner", @"bundleId": @"sample.app", @"processId": @42,
           @"sessionId": @"session-one", @"operation": @"input"};
}
static NSDictionary *Submit(AABWDAExecution *runtime, NSString *actionId, id value, NSString *effects)
{
  __block NSDictionary *result;
  [runtime submit:Body(actionId, 3000) target:Target() start:^(AABWDATask *task) {
    Require([task permission] == nil, @"normal action has permission");
    NSFileHandle *file = [NSFileHandle fileHandleForWritingAtPath:effects];
    [file seekToEndOfFile];
    [file writeData:[[actionId stringByAppendingString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding]];
    [file synchronizeFile]; [file closeFile];
    [task finish:@{@"ok": @YES, @"value": value}];
  } reply:^(NSDictionary *reply) { result = reply; }];
  Until(^BOOL { return result != nil; });
  return result;
}
int main(int argc, const char *argv[])
{
  @autoreleasepool {
    Require(argc == 3, @"usage: check DIRECTORY write|read");
    NSURL *directory = [NSURL fileURLWithPath:@(argv[1]) isDirectory:YES];
    NSString *mode = @(argv[2]);
    AABWDAReceiptStore *store = [[AABWDAReceiptStore alloc] initWithDirectory:directory runnerBundleId:@"test.runner"];
    Require(store.ready, @"actual segmented store opens");
    if ([mode isEqual:@"read"]) {
      AABWDAExecution *fresh = [[AABWDAExecution alloc] initWithStore:store epoch:@"new-runner"];
      NSDictionary *found = [fresh result:@"inflight" epoch:@"original-runner" cursor:nil];
      Require([found[@"found"] boolValue] && [found[@"receipt"][@"committed"] boolValue], @"fresh process reads the original durable completion");
      Require([found[@"executionResult"][@"execution"][@"target"] isEqual:Target()], @"cold completion retains exact original target");
      Require([found[@"executionResult"][@"error"] isEqual:@"ios_wda_action_cancelled"], @"new process cannot replace original result");
      printf("{\"ok\":true,\"mode\":\"cold-read\",\"physicalDeviceClaim\":false}\n");
      return 0;
    }
    NSString *effects = [[directory URLByAppendingPathComponent:@"effects.txt"] path];
    [NSData.data writeToFile:effects atomically:YES];
    AABWDAExecution *runtime = [[AABWDAExecution alloc] initWithStore:store epoch:@"original-runner"];
    __block NSUInteger starts = 0;
    __block NSDictionary *queuedReply;
    [runtime submit:Body(@"queued", 3000) target:Target() start:^(AABWDATask *task) { starts++; }
        reply:^(NSDictionary *value) { queuedReply = value; }];
    NSDictionary *queued = [runtime cancel:@"queued" epoch:@"original-runner"];
    Require([queued[@"found"] boolValue] && ![queued[@"executionResult"][@"dispatched"] boolValue], @"queued cancel commits without an event");
    Until(^BOOL { return queuedReply != nil; });
    Require(starts == 0, @"late main-queue work never starts");

    __block AABWDATask *inflight;
    __block NSDictionary *flightReply;
    [runtime submit:Body(@"inflight", 3000) target:Target() start:^(AABWDATask *task) {
      Require([task permission] == nil, @"original task has permission"); inflight = task;
    } reply:^(NSDictionary *value) { flightReply = value; }];
    Until(^BOOL { return inflight != nil; });
    NSDictionary *pending = [runtime cancel:@"inflight" epoch:@"original-runner"];
    Require([pending[@"ambiguous"] boolValue] && ![pending[@"settled"] boolValue], @"cancel after permission is not a completion");
    __block NSDictionary *busy;
    [runtime submit:Body(@"other", 3000) target:Target() start:^(AABWDATask *task) { starts++; }
        reply:^(NSDictionary *value) { busy = value; }];
    Require([busy[@"error"] isEqual:@"ios_wda_action_busy"], @"another task cannot bypass the outstanding callback");
    [inflight finish:@{@"ok": @"invalid"}];
    Require([runtime status][@"active"] != NSNull.null, @"invalid callback cannot settle");
    [inflight finish:@{@"ok": @YES, @"value": @"original callback"}];
    Until(^BOOL { return flightReply != nil; });
    Require([flightReply[@"settled"] boolValue] && [flightReply[@"dispatched"] boolValue] && ![flightReply[@"ambiguous"] boolValue],
            @"only the original callback settles an issued action");
    Require([[runtime status][@"active"] isEqual:NSNull.null], @"durable callback releases admission");

    __block NSDictionary *expired;
    [runtime submit:Body(@"deadline", 20) target:Target() start:^(AABWDATask *task) { starts++; }
        reply:^(NSDictionary *value) { expired = value; }];
    [NSThread sleepForTimeInterval:0.05]; // Deliberately hold the UI queue, not the control queue.
    Until(^BOOL { return expired != nil; });
    Require([expired[@"error"] isEqual:@"ios_wda_action_timeout"] && ![expired[@"dispatched"] boolValue] && starts == 0,
            @"native deadline cancels queued UI work");
    NSDictionary *invalid = Submit(runtime, @"invalid-json", NSDate.date, effects);
    Require([invalid[@"error"] isEqual:@"ios_wda_invalid_result"] && [invalid[@"settled"] boolValue], @"non-JSON original callback becomes a durable failure");

    for (NSUInteger i = 0; i < 70; i++) {
      NSDictionary *result = Submit(runtime, [NSString stringWithFormat:@"page-%lu", (unsigned long)i], NSNull.null, effects);
      Require([result[@"ok"] boolValue], @"pagination fixture commits");
    }
    NSDictionary *first = [store lookupAction:@"page-69" epoch:@"original-runner" cursor:nil];
    Require([first[@"hasMore"] boolValue] && ![first[@"found"] boolValue], @"one page has a bounded physical cursor");
    NSDictionary *wrong = [store lookupAction:@"inflight" epoch:@"original-runner" cursor:first[@"nextCursor"]];
    Require([wrong[@"error"] isEqual:@"invalid_ios_wda_completion_cursor"], @"cursor cannot change identity scope");
    NSDictionary *last = [store lookupAction:@"page-69" epoch:@"original-runner" cursor:first[@"nextCursor"]];
    Require([last[@"found"] boolValue] && [last[@"receipt"][@"committed"] boolValue], @"second page reads committed disk record");

    NSURL *faultDirectory = [directory URLByAppendingPathComponent:@"fault"];
    AABWDAReceiptStore *faultStore = [[AABWDAReceiptStore alloc] initWithDirectory:faultDirectory runnerBundleId:@"test.runner"];
    AABWDAExecution *fault = [[AABWDAExecution alloc] initWithStore:faultStore epoch:@"original-runner"];
    NSString *value = [@"x" stringByPaddingToLength:60 * 1024 withString:@"x" startingAtIndex:0];
    for (NSUInteger i = 0; i < 4; i++)
      Require([Submit(fault, [NSString stringWithFormat:@"fill-%lu", (unsigned long)i], value, effects)[@"ok"] boolValue], @"fill active physical segment");
    NSURL *partition = [faultDirectory URLByAppendingPathComponent:@"partition-5"];
    NSURL *moved = [faultDirectory URLByAppendingPathComponent:@"retained-partition"];
    Require([NSFileManager.defaultManager moveItemAtURL:partition toURL:moved error:NULL], @"move existing partition to make next segment creation fail");
    Require([NSData.data writeToURL:partition atomically:YES], @"put a file at the required partition directory");
    NSDictionary *failed = Submit(fault, @"disk-fault", value, effects);
    Require([failed[@"error"] isEqual:@"ios_wda_completion_store_unavailable"] && ![failed[@"settled"] boolValue], @"actual ENOTDIR keeps the completed candidate unresolved");
    Require([[fault status][@"active"][@"persistencePending"] boolValue], @"candidate stays held after failed disk commit");
    Require([NSFileManager.defaultManager removeItemAtURL:partition error:NULL]
      && [NSFileManager.defaultManager moveItemAtURL:moved toURL:partition error:NULL], @"restore the original physical partition");
    NSDictionary *saved = [fault cancel:@"disk-fault" epoch:@"original-runner"];
    Require([saved[@"found"] boolValue] && [saved[@"executionResult"][@"ok"] boolValue], @"retry persists the same finished candidate");
    NSString *allEffects = [NSString stringWithContentsOfFile:effects encoding:NSUTF8StringEncoding error:NULL];
    Require([allEffects componentsSeparatedByString:@"disk-fault\n"].count == 2, @"completion retry never replays an effect");
    NSDictionary *missing = [runtime result:@"never-completed" epoch:@"original-runner" cursor:nil];
    Require(![missing[@"found"] boolValue] && ![missing[@"settled"] boolValue], @"missing completion is not success");
    printf("{\"ok\":true,\"mode\":\"write\",\"scenarios\":8,\"physicalDeviceClaim\":false}\n");
  }
  return 0;
}
