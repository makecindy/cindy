Pod::Spec.new do |s|
  s.name = 'CindyQuotaWidget'
  s.version = '0.1.0'
  s.summary = 'Minimal subscription quota snapshots for Home Screen widgets.'
  s.description = s.summary
  s.license = { :type => 'Apache-2.0' }
  s.author = 'Cindy'
  s.homepage = 'https://github.com/makecindy/cindy'
  s.source = { git: s.homepage }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
  s.frameworks = 'WidgetKit'
end
