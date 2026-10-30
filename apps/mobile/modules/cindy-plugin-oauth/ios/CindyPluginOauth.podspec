Pod::Spec.new do |s|
  s.name = 'CindyPluginOauth'
  s.version = '1.0.0'
  s.summary = 'In-memory plugin OAuth loopback receiver'
  s.description = 'Receives one phone-controlled OAuth callback without token exchange or persistence.'
  s.author = 'Cindy'
  s.license = { :type => 'Apache-2.0', :file => '../../../../../LICENSE' }
  s.homepage = 'https://github.com/makecindy/cindy'
  s.platforms = { :ios => '16.4' }
  s.source = { git: 'https://github.com/makecindy/cindy.git' }
  s.swift_version = '5.9'
  s.frameworks = 'Network'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
