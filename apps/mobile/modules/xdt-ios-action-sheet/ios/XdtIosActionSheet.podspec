require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'XdtIosActionSheet'
  s.version        = package['version']
  s.summary        = 'System bottom sheet for unattached iOS action menus.'
  s.description    = 'Presents UISheetPresentationController for showActionMenu, avoiding RN ActionSheetIOS popover on iPhone.'
  s.license        = { :type => 'Apache-2.0', :file => '../../../../../LICENSE' }
  s.author         = 'Cindy'
  s.homepage       = 'https://github.com/makecindy/cindy'
  s.platforms      = {
    :ios => '16.4'
  }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/makecindy/cindy.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,swift}'
end
