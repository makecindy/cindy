#import "XdtAudioCapture.h"
#import <stdatomic.h>
#import <mach/mach_time.h>
#import <math.h>

// 4 MiB, allocated before engine.start. At a 10ms I/O period the ring tolerates
// 2.56s of consumer starvation. Overflow is an explicit incomplete-capture error.
enum { SlotCount = 256, MaxFrames = 4096 };
typedef struct { float samples[MaxFrames]; UInt32 frames; uint64_t hostTime; } AudioSlot;
typedef struct {
  AudioSlot slots[SlotCount];
  _Atomic(uint32_t) written;
  _Atomic(uint32_t) read;
  _Atomic(bool) overflow;
} AudioRing;

static OSStatus Capture(AudioRing *ring, const AudioTimeStamp *time,
                        AVAudioFrameCount frames, const AudioBufferList *input) {
  uint32_t written = atomic_load_explicit(&ring->written, memory_order_relaxed);
  uint32_t read = atomic_load_explicit(&ring->read, memory_order_acquire);
  if (frames > MaxFrames || written - read >= SlotCount) {
    atomic_store_explicit(&ring->overflow, true, memory_order_release);
    return noErr;
  }
  AudioSlot *slot = &ring->slots[written % SlotCount];
  UInt32 channels = 0;
  for (UInt32 b = 0; b < input->mNumberBuffers; b++) channels += input->mBuffers[b].mNumberChannels;
  if (channels == 0) return noErr;
  for (UInt32 f = 0; f < frames; f++) {
    float sample = 0;
    for (UInt32 b = 0; b < input->mNumberBuffers; b++) {
      const AudioBuffer *buffer = &input->mBuffers[b];
      const float *data = buffer->mData;
      for (UInt32 c = 0; c < buffer->mNumberChannels; c++) {
        sample += data ? data[f * buffer->mNumberChannels + c] : 0;
      }
    }
    slot->samples[f] = sample / channels;
  }
  slot->frames = frames;
  slot->hostTime = (time->mFlags & kAudioTimeStampHostTimeValid) ? time->mHostTime : mach_absolute_time();
  atomic_store_explicit(&ring->written, written + 1, memory_order_release);
  return noErr;
}

@implementation XdtAudioCapture {
  AudioRing *_ring;
  AVAudioSinkNode *_sink;
  double _targetRate;
  double _hostTicksToMs;
  double _wallAnchor;
  uint64_t _hostAnchor;
  uint64_t _sourceFrames;
  uint64_t _outputFrames;
  NSMutableData *_pending;
  double _pendingCapturedAt;
  NSInteger _chunkIndex;
}

- (instancetype)init {
  if ((self = [super init])) {
    _ring = calloc(1, sizeof(AudioRing));
    if (!_ring) return nil;
    _engine = [AVAudioEngine new];
    mach_timebase_info_data_t info;
    mach_timebase_info(&info);
    _hostTicksToMs = (double)info.numer / info.denom / 1e6;
  }
  return self;
}

- (void)dealloc {
  [self stop];
  free(_ring);
}

- (BOOL)overflowed { return atomic_load_explicit(&_ring->overflow, memory_order_acquire); }

- (BOOL)startWithSampleRate:(double)sampleRate error:(NSError **)error {
  [self stop];
  // A graph whose input unit survived session deactivation can accept start()
  // yet deliver no frames after a route/configuration change. Create it only
  // after the caller has activated the current session.
  _engine = [AVAudioEngine new];
  AVAudioInputNode *input = _engine.inputNode;
  AVAudioFormat *format = [input outputFormatForBus:0];
  if (format.commonFormat != AVAudioPCMFormatFloat32 || format.sampleRate <= 0 || format.channelCount == 0 ||
      !isfinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    if (error) *error = [NSError errorWithDomain:@"XdtAudioCapture" code:1
      userInfo:@{NSLocalizedDescriptionKey: @"Microphone did not provide a supported PCM format."}];
    return NO;
  }
  atomic_store(&_ring->written, 0);
  atomic_store(&_ring->read, 0);
  atomic_store(&_ring->overflow, false);
  _inputSampleRate = format.sampleRate;
  _targetRate = sampleRate;
  _sourceFrames = _outputFrames = 0;
  _chunkIndex = 0;
  _pending = [NSMutableData new];
  _hostAnchor = mach_absolute_time();
  _wallAnchor = NSDate.date.timeIntervalSince1970 * 1000;
  AudioRing *ring = _ring;
  // No ObjC/Swift calls, allocation, dispatch or locks in this receiver.
  _sink = [[AVAudioSinkNode alloc] initWithReceiverBlock:^OSStatus(
    const AudioTimeStamp *time, AVAudioFrameCount frames, const AudioBufferList *data) {
      return Capture(ring, time, frames, data);
  }];
  [_engine attachNode:_sink];
  [_engine connect:input to:_sink format:format];
  [_engine prepare];
  if ([_engine startAndReturnError:error]) return YES;
  [self stop];
  return NO;
}

- (NSDictionary *)takePending {
  NSUInteger frames = _pending.length / sizeof(int16_t);
  NSDictionary *packet = @{
    @"base64Pcm16": [_pending base64EncodedStringWithOptions:0],
    @"capturedAt": @(_pendingCapturedAt), @"chunkIndex": @(_chunkIndex++),
    @"sampleRate": @(_targetRate), @"durationMs": @(frames / _targetRate * 1000)
  };
  [_pending setLength:0];
  return packet;
}

- (NSArray<NSDictionary *> *)drain {
  NSMutableArray *packets = [NSMutableArray new];
  uint32_t read = atomic_load_explicit(&_ring->read, memory_order_relaxed);
  const uint32_t written = atomic_load_explicit(&_ring->written, memory_order_acquire);
  while (read != written) {
    const AudioSlot *slot = &_ring->slots[read % SlotCount];
    uint64_t end = _sourceFrames + slot->frames;
    uint64_t outputEnd = (uint64_t)ceil(end * _targetRate / _inputSampleRate);
    for (; _outputFrames < outputEnd; _outputFrames++) {
      uint64_t source = (uint64_t)floor(_outputFrames * _inputSampleRate / _targetRate);
      UInt32 offset = (UInt32)(source - _sourceFrames);
      if (_pending.length == 0) {
        // Subtract as signed: input timestamps can predate engine.start.
        _pendingCapturedAt = _wallAnchor + ((int64_t)(slot->hostTime - _hostAnchor)) * _hostTicksToMs
          + offset / _inputSampleRate * 1000;
      }
      float value = fmaxf(-1, fminf(1, slot->samples[MIN(offset, slot->frames - 1)]));
      int16_t sample = (int16_t)(value * INT16_MAX);
      [_pending appendBytes:&sample length:sizeof(sample)];
      // First packet 10ms, subsequent packets 40ms: hardware latency is
      // independent of ASR network packet frequency.
      NSUInteger framesPerPacket = (NSUInteger)llround(_targetRate * (_chunkIndex == 0 ? .010 : .040));
      if (_pending.length / sizeof(int16_t) >= framesPerPacket) [packets addObject:[self takePending]];
    }
    _sourceFrames = end;
    read++;
    atomic_store_explicit(&_ring->read, read, memory_order_release);
  }
  if (!_engine.isRunning && _pending.length) [packets addObject:[self takePending]];
  return packets;
}

- (void)stop {
  [_engine stop];
  if (_sink) {
    [_engine disconnectNodeInput:_sink];
    [_engine detachNode:_sink];
    _sink = nil;
  }
}
@end
