{
  'targets': [{
    'target_name': 'cindy-file-preview',
    'type': 'executable',
    'sources': ['preview.cpp'],
    'libraries': ['shell32.lib', 'shlwapi.lib', 'ole32.lib', 'uuid.lib', 'user32.lib'],
    'msvs_settings': { 'VCLinkerTool': { 'SubSystem': '2' } }
  }]
}
