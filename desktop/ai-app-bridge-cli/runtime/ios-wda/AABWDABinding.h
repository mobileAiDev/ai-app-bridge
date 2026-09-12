#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

// Process routing identity is published inside the selected Runner's container.
// It is not a device UDID or an authentication mechanism.
@interface AABWDABinding : NSObject
@property(atomic, copy, readonly) NSDictionary *identity;
@property(atomic, readonly) BOOL ready;
+ (instancetype)shared;
- (instancetype)initWithDirectory:(NSURL *)directory bundleId:(NSString *)bundleId
                       processId:(NSNumber *)processId runtimeEpoch:(NSString *)runtimeEpoch;
- (BOOL)publishPort:(NSUInteger)port error:(NSError **)error;
- (nullable NSString *)runtimeErrorForHeaders:(NSDictionary *)headers;
- (nullable NSString *)targetErrorForHeaders:(NSDictionary *)headers
                               actualTarget:(NSDictionary *)target sessionId:(nullable NSString *)sessionId;
@end

NS_ASSUME_NONNULL_END
