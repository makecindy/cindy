#import <AVFoundation/AVFoundation.h>

NS_ASSUME_NONNULL_BEGIN
/// Single-producer audio ring. Only copy/downmix runs on the render thread;
/// resampling and bridging run on the caller's serialized non-realtime queue.
@interface XdtAudioCapture : NSObject
@property(nonatomic, readonly) AVAudioEngine *engine;
@property(nonatomic, readonly) double inputSampleRate;
@property(nonatomic, readonly) BOOL overflowed;
- (BOOL)startWithSampleRate:(double)sampleRate error:(NSError **)error;
- (NSArray<NSDictionary *> *)drain;
- (void)stop;
@end
NS_ASSUME_NONNULL_END
