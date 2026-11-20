{
  'targets': [{
    'target_name': 'cindy-file-preview',
    'type': 'executable',
    'sources': ['preview.cpp'],
    'libraries': ['shell32.lib', 'shlwapi.lib', 'ole32.lib', 'uuid.lib', 'user32.lib'],
    # node-gyp selects Console for executables in a late target condition.
    'msvs_settings': { 'VCLinkerTool': { 'target_conditions': [
      ['_type=="executable"', { 'SubSystem': 2 }]
    ] } }
  }]
}
