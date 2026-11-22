Pod::Spec.new do |s|
  s.name = 'CindyAgentNetNative'
  s.version = '0.1.0'
  s.summary = 'Cindy Agent-Net native transport host.'
  s.homepage = 'https://github.com/makecindy/cindy'
  s.license = { :type => 'Apache-2.0', :file => '../../LICENSE' }
  s.author = 'Cindy'
  s.source = { :git => 'https://github.com/makecindy/cindy.git' }
  s.platforms = { :ios => '16.4' }
  s.static_framework = true
  s.vendored_frameworks = 'dist/CindyAgentNetNative.xcframework'
end
