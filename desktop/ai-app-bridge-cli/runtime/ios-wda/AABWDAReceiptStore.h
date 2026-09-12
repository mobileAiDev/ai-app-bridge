#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN
@interface AABWDAReceiptStore : NSObject
@property(nonatomic, readonly) BOOL ready;
- (instancetype)initWithDirectory:(NSURL *)directory runnerBundleId:(NSString *)bundleId;
- (nullable NSDictionary *)commit:(NSDictionary *)result;
- (NSDictionary *)lookupAction:(NSString *)actionId epoch:(NSString *)epoch cursor:(nullable NSString *)cursor;
@end
NS_ASSUME_NONNULL_END
