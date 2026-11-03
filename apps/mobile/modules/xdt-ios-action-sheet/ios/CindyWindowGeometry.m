#import "CindyWindowGeometry.h"

#if __has_include(<UIKit/UIViewReservedRegion.h>) && __has_include(<UIKit/UIVerticalBarEdge.h>)
#define CINDY_RESERVED_REGIONS 1
#else
#define CINDY_RESERVED_REGIONS 0
#endif

@interface CindyWindowGeometry (Observation)
- (void)publishGeometry;
@end
/// CADisplayLink retains its target; the target must not retain the observed view.
@interface CindyGeometryTick : NSObject
@property(nonatomic, weak) CindyWindowGeometry *view;
- (void)tick;
@end
@implementation CindyGeometryTick
- (void)tick { [self.view publishGeometry]; }
@end

@implementation CindyWindowGeometry {
  CADisplayLink *_displayLink;
  NSDictionary *_lastGeometry;
}
- (instancetype)initWithFrame:(CGRect)frame {
  if ((self = [super initWithFrame:frame])) {
    self.userInteractionEnabled = NO;
    self.accessibilityElementsHidden = YES;
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(stopObserving)
      name:UIApplicationDidEnterBackgroundNotification object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(startObserving)
      name:UIApplicationDidBecomeActiveNotification object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(sceneChanged:)
      name:UISceneDidActivateNotification object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(sceneChanged:)
      name:UISceneWillDeactivateNotification object:nil];
  }
  return self;
}
- (void)dealloc {
  [_displayLink invalidate];
  [NSNotificationCenter.defaultCenter removeObserver:self];
}
- (void)didMoveToWindow {
  [super didMoveToWindow];
  [self stopObserving];
  _lastGeometry = nil;
  [self startObserving];
}
- (void)sceneChanged:(NSNotification *)notification {
  if (notification.object != self.window.windowScene) return;
  if ([notification.name isEqualToString:UISceneWillDeactivateNotification]) [self stopObserving];
  else [self startObserving];
}
- (void)stopObserving { [_displayLink invalidate]; _displayLink = nil; }
- (void)startObserving {
  if (!self.window || self.window.windowScene.activationState != UISceneActivationStateForegroundActive) return;
  [self publishGeometry];
#if CINDY_RESERVED_REGIONS
  if (@available(iOS 27.1, *)) {
    // A region can move without bounds or size-class changes (hinge/camera).
    // Sample only attached, active views; unchanged snapshots never cross JS.
    if (!_displayLink) {
      CindyGeometryTick *target = [CindyGeometryTick new];
      target.view = self;
      _displayLink = [CADisplayLink displayLinkWithTarget:target selector:@selector(tick)];
      _displayLink.preferredFrameRateRange = CAFrameRateRangeMake(5, 10, 10);
      [_displayLink addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
    }
  }
#endif
}
- (void)layoutSubviews { [super layoutSubviews]; [self publishGeometry]; }
- (void)safeAreaInsetsDidChange { [super safeAreaInsetsDidChange]; [self publishGeometry]; }
- (void)traitCollectionDidChange:(UITraitCollection *)previous {
  [super traitCollectionDidChange:previous];
  [self publishGeometry];
}
- (void)publishGeometry {
  if (!self.window || CGRectIsEmpty(self.bounds)) return;
  UIEdgeInsets safe = self.safeAreaInsets;
  NSMutableArray *regions = [NSMutableArray array];
  NSString *edge = @"none";
  BOOL supported = NO;
#if CINDY_RESERVED_REGIONS
  if (@available(iOS 27.1, *)) {
    supported = YES;
    // These edges are hardware-relative, not mirrored for RTL content.
    switch (self.traitCollection.verticalBarEdge) {
      case UIVerticalBarEdgeLeading: edge = @"left"; break;
      case UIVerticalBarEdgeTrailing: edge = @"right"; break;
      default: break;
    }
    NSArray *kinds = @[UIViewReservedRegionKind.divisionRegionKind, UIViewReservedRegionKind.occlusionRegionKind];
    for (NSUInteger i = 0; i < kinds.count; i++) {
      for (UIViewReservedRegion *region in [self reservedRegionsOfKind:kinds[i]]) {
        CGRect rect = CGRectIntersection(self.bounds, region.frame);
        if (CGRectIsNull(rect) || CGRectIsEmpty(rect)) continue;
        [regions addObject:@{@"kind": i == 0 ? @"division" : @"occlusion",
          @"x": @(rect.origin.x), @"y": @(rect.origin.y),
          @"width": @(rect.size.width), @"height": @(rect.size.height)}];
      }
    }
  }
#endif
  NSDictionary *geometry = @{
    @"width": @(self.bounds.size.width), @"height": @(self.bounds.size.height),
    @"insets": @{@"top": @(safe.top), @"right": @(safe.right), @"bottom": @(safe.bottom), @"left": @(safe.left)},
    @"regularWidth": @(self.traitCollection.horizontalSizeClass == UIUserInterfaceSizeClassRegular),
    @"regularHeight": @(self.traitCollection.verticalSizeClass == UIUserInterfaceSizeClassRegular),
    @"barEdge": edge, @"regions": regions, @"reservedRegionsSupported": @(supported)
  };
  if ([_lastGeometry isEqualToDictionary:geometry]) return;
  _lastGeometry = geometry;
  if (self.onChange) self.onChange(geometry);
}
@end
