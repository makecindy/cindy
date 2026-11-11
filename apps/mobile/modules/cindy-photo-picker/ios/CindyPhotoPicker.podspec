Pod::Spec.new do |s|
  s.name = 'CindyPhotoPicker'
  s.version = '0.1.0'
  s.summary = 'Immediate photo selection with deferred, cancellable file loading.'
  s.description = s.summary
  s.license = { :type => 'Apache-2.0' }
  s.author = 'Cindy'
  s.homepage = 'https://github.com/makecindy/cindy'
  s.source = { git: s.homepage }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
end
