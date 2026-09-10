Pod::Spec.new do |s|
  s.name = 'CindyRemoteCredentialsModule'
  s.version = '0.1.0'
  s.summary = 'Native remote desktop credential bridge for Cindy.'
  s.description = 'Bridges opaque credential sessions without JavaScript password access.'
  s.license = { :type => 'Apache-2.0', :file => '../../../../../LICENSE' }
  s.author = 'Cindy'
  s.homepage = 'https://github.com/makecindy/cindy'
  s.source = { :git => 'https://github.com/makecindy/cindy.git' }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.source_files = '**/*.{h,m,swift}'
  s.dependency 'ExpoModulesCore'
  s.dependency 'CindyRemoteCredentials', '= 0.1.0'
end
