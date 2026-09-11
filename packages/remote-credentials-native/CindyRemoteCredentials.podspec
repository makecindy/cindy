Pod::Spec.new do |s|
  s.name = 'CindyRemoteCredentials'
  s.version = '0.1.0'
  s.summary = 'Native device identity and remote desktop credential transactions.'
  s.description = 'Native encrypted sessions, password entry and protected credential storage.'
  s.license = { :type => 'Apache-2.0', :file => '../../LICENSE' }
  s.author = 'Cindy'
  s.homepage = 'https://github.com/makecindy/cindy'
  s.source = { :git => 'https://github.com/makecindy/cindy.git' }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.source_files = 'Sources/CindyRemoteCredentials/**/*.swift'
  s.resource_bundles = { 'CindyRemoteCredentialsResources' => ['Sources/CindyRemoteCredentials/Resources/*.json'] }
  s.dependency 'JOSESwift', '= 3.0.0'
end
