Pod::Spec.new do |s|
  s.name = 'CindyNotificationState'
  s.version = '0.1.0'
  s.summary = 'Reconcile delivered Cindy notifications'
  s.description = s.summary
  s.license = { :type => 'Apache-2.0' }
  s.author = 'Cindy'
  s.homepage = 'https://github.com/makecindy/cindy'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { git: s.homepage }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'UserNotifications', 'Security'
  s.source_files = '**/*.swift'
end
