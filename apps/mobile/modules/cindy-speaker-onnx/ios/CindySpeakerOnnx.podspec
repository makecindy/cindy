require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'CindySpeakerOnnx'
  s.version        = package['version']
  s.summary        = 'On-device ONNX inference for the Cindy voice input speaker filter.'
  s.description    = 'Expo module that runs the speaker filter VAD and voiceprint models with ONNX Runtime.'
  s.license        = { :type => 'Apache-2.0', :file => '../../../../../LICENSE' }
  s.author         = 'Cindy'
  s.homepage       = 'https://github.com/makecindy/cindy'
  s.platforms      = {
    :ios => '16.4'
  }
  s.swift_version  = '5.0'
  s.source         = { git: 'https://github.com/makecindy/cindy.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # Official Microsoft build; keep in step with onnxruntime-android in ../android/build.gradle.
  s.dependency 'onnxruntime-objc', '1.30.0'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,swift}'
end
