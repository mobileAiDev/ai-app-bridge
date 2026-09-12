#import <Foundation/Foundation.h>
#import "AABWDABinding.h"

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSURL *directory = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[1]]];
    AABWDABinding *first = [[AABWDABinding alloc] initWithDirectory:directory bundleId:@"sample.runner" processId:@42 runtimeEpoch:@"epoch-1"];
    NSDictionary *headers = @{ @"X-AAB-WDA-Schema":@"aab.ios-wda/v1", @"X-AAB-WDA-Bundle-Id":@"sample.runner",
      @"X-AAB-WDA-Runtime-Epoch":@"epoch-1", @"X-AAB-WDA-Process-Id":@"42", @"X-AAB-WDA-Port":@"8100" };
    NSCAssert([[first runtimeErrorForHeaders:headers] isEqual:@"ios_wda_descriptor_not_ready"], @"Unpublished identity admitted a request");
    NSError *error;
    NSCAssert([first publishPort:8100 error:&error], @"%@", error);
    NSCAssert(![first runtimeErrorForHeaders:headers], @"Matching identity rejected");
    NSCAssert([first runtimeErrorForHeaders:@{}], @"Missing headers accepted");
    for (NSString *key in headers) {
      NSMutableDictionary *wrong = headers.mutableCopy; wrong[key] = @"other";
      NSCAssert([first runtimeErrorForHeaders:wrong], @"Wrong %@ accepted", key);
    }
    NSMutableDictionary *duplicate = headers.mutableCopy; duplicate[@"x-aab-wda-port"] = @"8100";
    NSCAssert([first runtimeErrorForHeaders:duplicate], @"Duplicate header accepted");
    NSURL *file = [directory URLByAppendingPathComponent:@"ai_app_bridge_wda.json"];
    NSDictionary *saved = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfURL:file] options:0 error:&error];
    NSCAssert([saved[@"runtimeEpoch"] isEqual:@"epoch-1"] && [saved[@"port"] isEqual:@8100], @"Descriptor not written");
    AABWDABinding *second = [[AABWDABinding alloc] initWithDirectory:directory bundleId:@"sample.runner" processId:@43 runtimeEpoch:@"epoch-2"];
    NSCAssert([second publishPort:8200 error:&error], @"New process cannot publish");
    NSCAssert([second runtimeErrorForHeaders:headers], @"New process accepted old identity");
    saved = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfURL:file] options:0 error:&error];
    NSCAssert([saved[@"runtimeEpoch"] isEqual:@"epoch-2"] && [saved[@"processId"] isEqual:@43], @"Original descriptor not replaced");
    NSDictionary *target = @{ @"bundleId":@"sample.app", @"processId":@100 };
    NSMutableDictionary *selected = headers.mutableCopy;
    selected[@"X-AAB-WDA-Target-Bundle-Id"] = @"sample.app";
    selected[@"X-AAB-WDA-Target-Process-Id"] = @"100";
    selected[@"X-AAB-WDA-Session-Id"] = @"session-1";
    NSCAssert(![first targetErrorForHeaders:selected actualTarget:target sessionId:@"session-1"], @"Target rejected");
    NSCAssert([first targetErrorForHeaders:selected actualTarget:target sessionId:@"session-2"], @"Session replacement accepted");
    NSCAssert(([first targetErrorForHeaders:selected actualTarget:@{@"bundleId":@"other.app",@"processId":@100} sessionId:@"session-1"]), @"Other App accepted");
    NSCAssert(([first targetErrorForHeaders:selected actualTarget:@{@"bundleId":@"sample.app",@"processId":@101} sessionId:@"session-1"]), @"App restart accepted");
    NSCAssert([first targetErrorForHeaders:selected actualTarget:@{} sessionId:@"session-1"], @"Missing foreground accepted");
    AABWDABinding *unwritable = [[AABWDABinding alloc] initWithDirectory:file bundleId:@"sample.runner" processId:@44 runtimeEpoch:@"epoch-3"];
    NSCAssert(![unwritable publishPort:8100 error:&error], @"Publication through a file should fail");
    NSCAssert([unwritable runtimeErrorForHeaders:headers], @"Failed publication admitted a request");
    puts("{\"ok\":true,\"physicalDeviceClaim\":false}");
  }
  return 0;
}
