#import <Foundation/Foundation.h>
#import "AABWDAReceiptStore.h"

NS_ASSUME_NONNULL_BEGIN
@class AABWDATask;
typedef void (^AABWDAReply)(NSDictionary *);
typedef void (^AABWDAStart)(AABWDATask *);

// The execution state is independent of the WDA main UI queue. A task must get
// permission immediately before each event, and finish only from original callbacks.
@interface AABWDATask : NSObject
@property(nonatomic, copy, readonly) NSDictionary *body;
@property(nonatomic, copy, readonly) NSDictionary *target;
- (nullable NSString *)permission;
- (void)finish:(NSDictionary *)outcome;
- (void)unresolved:(NSString *)reason;
@end

@interface AABWDAExecution : NSObject
- (instancetype)initWithStore:(AABWDAReceiptStore *)store epoch:(NSString *)epoch;
- (void)submit:(NSDictionary *)body target:(NSDictionary *)target start:(AABWDAStart)start reply:(AABWDAReply)reply;
- (NSDictionary *)cancel:(NSString *)actionId epoch:(NSString *)epoch;
- (NSDictionary *)status;
- (NSDictionary *)result:(NSString *)actionId epoch:(NSString *)epoch cursor:(nullable NSString *)cursor;
@end
NS_ASSUME_NONNULL_END
