Pod::Spec.new do |s|
  s.name         = 'CindyAppIcon'
  s.version      = '0.1.0'
  s.summary      = 'Read and switch the iOS alternate app icon.'
  s.description  = s.summary
  s.license      = { :type => 'Apache-2.0', :file => '../../../../../LICENSE' }
  s.author       = 'Cindy'
  s.homepage     = 'https://github.com/makecindy/cindy'
  s.platforms    = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source       = { git: 'https://github.com/makecindy/cindy.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
  s.source_files = '**/*.{h,m,swift}'
end
