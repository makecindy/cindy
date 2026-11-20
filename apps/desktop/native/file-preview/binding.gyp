{
  'targets': [{
    'target_name': 'cindy-file-preview',
    'type': 'executable',
    'sources': ['preview.cpp'],
    'libraries': ['shell32.lib', 'shlwapi.lib', 'ole32.lib', 'uuid.lib', 'user32.lib'],
    # 子系统必须写在 target_conditions 里：node 的 common.gypi 在 target_defaults 用
    # target_conditions 把 executable 的 VCLinkerTool.SubSystem 设成 1（控制台），它在
    # target 自身的 msvs_settings 之后展开。直接写 'SubSystem': '2' 会被覆盖成 Console，
    # 链接器按 main 查找入口，而 preview.cpp 只有 wWinMain，于是报
    # LNK2001: unresolved external symbol main。
    # 这里同样走 target_conditions 才能最后生效，得到 /SUBSYSTEM:WINDOWS；
    # 入口由链接器按 wWinMain 自动选 wWinMainCRTStartup，不需要 EntryPointSymbol。
    'msvs_settings': {
      'VCLinkerTool': {
        'target_conditions': [['_type=="executable"', { 'SubSystem': '2' }]],
      },
    },
  }]
}
