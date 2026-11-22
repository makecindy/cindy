Pod::Spec.new do |s|
  s.name = 'CindyAgentNetModule'
  s.version = '0.1.0'
  s.summary = 'Cindy Agent-Net native bridge.'
  s.homepage = 'https://github.com/makecindy/cindy'
  s.license = { :type => 'Apache-2.0', :file => '../../../../../LICENSE' }
  s.author = 'Cindy'
  s.source = { :git => 'https://github.com/makecindy/cindy.git' }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.source_files = '**/*.{h,m,swift}'
  s.dependency 'ExpoModulesCore'
  s.dependency 'CindyAgentNetNative', '= 0.1.0'
end
