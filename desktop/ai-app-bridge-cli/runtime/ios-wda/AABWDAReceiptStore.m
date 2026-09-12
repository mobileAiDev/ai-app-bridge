#import "AABWDAReceiptStore.h"
#import <CommonCrypto/CommonDigest.h>
#include "sfs.h"

static NSString *AABWDADigest(NSData *data)
{
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  NSMutableString *value = [NSMutableString string];
  for (NSUInteger i = 0; i < sizeof(digest); i++) [value appendFormat:@"%02x", digest[i]];
  return value;
}

static BOOL AABWDAInteger(id value, uint64_t minimum, uint64_t maximum)
{
  return [value isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID()
    && [value doubleValue] >= minimum && [value doubleValue] <= maximum
    && [value doubleValue] == (double)[value unsignedLongLongValue];
}

static NSDictionary *AABWDAStoreFailure(NSString *code)
{
  return @{@"ok": @NO, @"error": code, @"settled": @NO};
}

@implementation AABWDAReceiptStore {
  sfs_store_t *_store;
  NSString *_bundleId;
}
- (instancetype)initWithDirectory:(NSURL *)directory runnerBundleId:(NSString *)bundleId
{
  self = [super init];
  if (self) {
    _bundleId = bundleId.copy;
    if (![NSFileManager.defaultManager createDirectoryAtURL:directory withIntermediateDirectories:YES attributes:nil error:NULL]) return self;
    sfs_open_options_t options = {0};
    options.struct_size = sizeof(options); options.flags = SFS_OPEN_CREATE;
    options.directory = directory.fileSystemRepresentation; options.segment_size = 256 * 1024;
    options.partition_quotas[5] = 8 * 1024 * 1024;
    sfs_open(&options, &_store, NULL);
  }
  return self;
}
- (void)dealloc { if (_store) sfs_close(_store, NULL); }
- (BOOL)ready { return _store != NULL; }

- (NSDictionary *)commit:(NSDictionary *)result
{
  @synchronized (self) {
    if (!_store) return nil;
    NSDictionary *record = @{@"schemaVersion": @"aab.wda-completion/v1", @"runnerBundleId": _bundleId, @"executionResult": result};
    if (![NSJSONSerialization isValidJSONObject:record]) return nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:record options:NSJSONWritingSortedKeys error:NULL];
    if (!data || data.length > 128 * 1024) return nil;
    sfs_record_info_t info = {0}; info.struct_size = sizeof(info);
    if (sfs_append(_store, 5, data.bytes, (uint32_t)data.length, SFS_DURABILITY_SYNC, &info, NULL) != SFS_OK || info.sequence == 0) return nil;
    return @{@"committed": @YES, @"sequence": @(info.sequence), @"sha256": AABWDADigest(data)};
  }
}

- (NSDictionary *)lookupAction:(NSString *)actionId epoch:(NSString *)epoch cursor:(NSString *)encoded
{
  @synchronized (self) {
    sfs_status_t status = {0}; status.struct_size = sizeof(status);
    if (!_store || sfs_flush(_store, NULL) != SFS_OK || sfs_status(_store, &status, NULL) != SFS_OK)
      return AABWDAStoreFailure(@"ios_wda_completion_store_unavailable");
    NSString *scope = AABWDADigest([NSJSONSerialization dataWithJSONObject:@[_bundleId, actionId, epoch] options:0 error:NULL]);
    uint64_t through = status.next_sequence - 1;
    sfs_cursor_t cursor = SFS_CURSOR_PARTITION(5);
    if (encoded) {
      NSData *bytes = encoded.length <= 2048 ? [[NSData alloc] initWithBase64EncodedString:encoded options:0] : nil;
      NSDictionary *value = bytes ? [NSJSONSerialization JSONObjectWithData:bytes options:0 error:NULL] : nil;
      if (![value isKindOfClass:NSDictionary.class] || ![value[@"scope"] isEqual:scope]
          || ![value[@"version"] isEqual:@1] || !AABWDAInteger(value[@"after"], 1, through)
          || !AABWDAInteger(value[@"through"], 1, through) || !AABWDAInteger(value[@"segment"], 1, UINT32_MAX)
          || !AABWDAInteger(value[@"offset"], 64, 256 * 1024)
          || [value[@"after"] unsignedLongLongValue] >= [value[@"through"] unsignedLongLongValue])
        return AABWDAStoreFailure(@"invalid_ios_wda_completion_cursor");
      cursor.after_sequence = [value[@"after"] unsignedLongLongValue];
      cursor.segment_id = [value[@"segment"] unsignedLongLongValue];
      cursor.offset = [value[@"offset"] unsignedLongLongValue];
      through = [value[@"through"] unsignedLongLongValue];
    }
    uint64_t before = cursor.after_sequence;
    NSMutableData *buffer = [NSMutableData dataWithLength:128 * 1024];
    NSUInteger readBytes = 0;
    BOOL ended = before == through;
    for (NSUInteger count = 0; !ended && count < 64 && readBytes < 2 * 1024 * 1024; count++) {
      sfs_record_info_t info = {0}; info.struct_size = sizeof(info);
      sfs_result_t read = sfs_scan(_store, &cursor, buffer.mutableBytes, (uint32_t)buffer.length, &info, NULL);
      if (read == SFS_END) { ended = YES; break; }
      if (read != SFS_OK) return AABWDAStoreFailure(@"ios_wda_completion_read_failed");
      if (info.sequence > through) { ended = YES; break; }
      readBytes += info.payload_length;
      NSData *data = [buffer subdataWithRange:NSMakeRange(0, info.payload_length)];
      NSDictionary *record = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
      if (![record isKindOfClass:NSDictionary.class] || ![record[@"schemaVersion"] isEqual:@"aab.wda-completion/v1"]
          || ![record[@"runnerBundleId"] isEqual:_bundleId]) return AABWDAStoreFailure(@"invalid_ios_wda_completion_record");
      NSDictionary *result = record[@"executionResult"];
      if (![result isKindOfClass:NSDictionary.class]) return AABWDAStoreFailure(@"invalid_ios_wda_completion_record");
      if ([result[@"actionId"] isEqual:actionId] && [result[@"runtimeEpoch"] isEqual:epoch])
        return @{@"ok": @YES, @"found": @YES, @"actionId": actionId, @"runtimeEpoch": epoch, @"executionResult": result,
          @"receipt": @{@"committed": @YES, @"sequence": @(info.sequence), @"sha256": AABWDADigest(data)}};
      ended = cursor.after_sequence >= through;
    }
    uint64_t after = MIN(cursor.after_sequence, through);
    BOOL more = !ended && after < through;
    if (more && after <= before) return AABWDAStoreFailure(@"ios_wda_completion_cursor_stalled");
    NSDictionary *next = @{@"version": @1, @"scope": scope, @"after": @(after), @"through": @(through),
                          @"segment": @(cursor.segment_id), @"offset": @(cursor.offset)};
    id nextCursor = more ? [[NSJSONSerialization dataWithJSONObject:next options:0 error:NULL] base64EncodedStringWithOptions:0] : NSNull.null;
    return @{@"ok": @YES, @"found": @NO, @"settled": @NO, @"hasMore": @(more),
             @"nextSequence": @(after), @"throughSequence": @(through), @"nextCursor": nextCursor};
  }
}
@end
