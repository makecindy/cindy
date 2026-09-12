Pod::Spec.new do |s|
  s.name           = 'CindyHtmlPreview'
  s.version        = '1.0.0'
  s.summary        = 'Loopback static HTML snapshot preview for Cindy'
  s.description    = 'A bounded read-only HTTP listener for downloaded HTML snapshots.'
  s.author         = 'Cindy'
  s.license        = { :type => 'Apache-2.0', :file => '../../../../../LICENSE' }
  s.homepage       = 'https://github.com/makecindy/cindy'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: 'https://github.com/makecindy/cindy.git' }
  s.swift_version  = '5.9'
  s.frameworks    = 'Network'
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
