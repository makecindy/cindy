#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN
/// View-local layout observation; never chooses a window from connectedScenes.
@interface CindyWindowGeometry : UIView
@property(nonatomic, copy, nullable) void (^onChange)(NSDictionary *geometry);
@end
NS_ASSUME_NONNULL_END
