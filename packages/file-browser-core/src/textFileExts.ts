/**
 * textFileExts — 文本/代码/markdown 文件类型白名单。
 *
 * 抽到 shared 是因为 main 和 renderer 都要消费:
 *  - renderer/lib/fileTypes.ts: 附件分类、预览能力判断
 *  - main/file-browser/search/RipgrepSearcher.ts: 把这套白名单转成 rg --glob,
 *    让 doc 全库搜索只在文本文件里搜内容(不浪费 rg 时间扫 .pdf/.png 之类)
 *
 * 改这里要同步想清楚两侧的影响:新增扩展名既会让附件支持新类型,也会让搜索
 * 范围变大。
 */

/**
 * 支持以"文本"形式预览/搜索的扩展名(全部小写,带 leading dot)。
 *
 * 命名口径:
 *  - 主流编程语言源码
 *  - 配置/数据格式 (json/yaml/toml/ini/xml/csv...)
 *  - 文档/标记 (md/rst/tex/txt...)
 *  - 日志/diff/补丁
 *  - dotfile (.gitignore / .env / .prettierrc 等; extractExt 会把整个名字当 ext)
 */
export const SUPPORTED_TEXT_EXTS = new Set<string>([
  // Mainstream languages
  '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java',
  '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hh', '.cs', '.rb', '.php',
  '.swift', '.kt', '.kts', '.scala', '.groovy', '.coffee',
  // Less common but still readable as text
  '.lua', '.dart', '.r', '.pl', '.pm', '.ex', '.exs', '.elm',
  '.clj', '.cljs', '.cljc', '.fs', '.fsi', '.fsx', '.ml', '.mli',
  '.hs', '.erl', '.hrl', '.zig', '.nim', '.vim', '.applescript',
  // Shells
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.psm1', '.bat', '.cmd',
  // Web / markup
  '.html', '.htm', '.xhtml', '.css', '.scss', '.sass', '.less', '.styl',
  '.vue', '.svelte', '.astro', '.svg', '.razor', '.cshtml',
  // Data / config
  '.json', '.json5', '.jsonc', '.jsonl', '.ndjson', '.geojson',
  '.yaml', '.yml', '.xml', '.toml', '.ini', '.conf', '.cfg', '.properties',
  '.plist', '.tf', '.tfvars', '.hcl', '.gradle', '.cmake', '.mk', '.mak',
  '.lock', '.csv', '.tsv',
  // Docs
  '.md', '.markdown', '.mdx', '.rst', '.tex', '.bib', '.cls', '.sty',
  '.adoc', '.asciidoc', '.org', '.txt', '.text',
  // Logs / diffs
  '.log', '.diff', '.patch',
  // Subtitles
  '.srt', '.vtt',
  // Translation
  '.po', '.pot',
  // Project / build files
  '.sln', '.csproj', '.vbproj', '.fsproj', '.gemspec', '.podspec', '.cabal',
  // .NET project/configuration sources and related schema formats (text only).
  '.vbhtml', '.vb', '.csx', '.cake', '.linq', '.props',
  '.targets', '.slnx', '.slnf', '.config', '.resx', '.settings',
  '.manifest', '.nuspec', '.runsettings', '.globalconfig', '.http', '.rest',
  '.xaml', '.axaml', '.resw', '.rdlc', '.rdl', '.pubxml',
  '.ruleset', '.dotsettings', '.testsettings', '.filters', '.gql', '.graphqls',
  '.psd1', '.ps1xml', '.psql', '.bicep', '.fbs', '.thrift',
  '.capnp', '.avsc', '.csproj.user', '.fsproj.user', '.vbproj.user',
  // DB / API
  '.sql', '.graphql', '.proto', '.dockerfile',
  // Feeds
  '.rss', '.atom',
  // Dotfiles (extractExt 把 .foo 整体当 ext 处理)
  '.gitignore', '.gitattributes', '.gitconfig', '.gitmodules', '.gitkeep',
  '.dockerignore', '.eslintignore', '.prettierignore', '.npmignore',
  '.editorconfig', '.env', '.env.local', '.env.development', '.env.production', '.env.example',
  '.prettierrc', '.eslintrc', '.babelrc', '.npmrc', '.yarnrc',
  '.stylelintrc', '.huskyrc', '.lintstagedrc', '.browserslistrc',
  '.nvmrc', '.node-version', '.python-version', '.ruby-version', '.tool-versions',
]);

/**
 * 多段扩展名(整体作为 ext 看待),让 extractExt 优先按 "longest match" 切。
 * 必须是小写。
 */
export const COMPOUND_EXTS: string[] = [
  '.env.example', '.env.local', '.env.development', '.env.production',
  '.csproj.user', '.fsproj.user', '.vbproj.user',
];

/**
 * 没有扩展名、但按文件名整体应该当文本/代码处理的特殊文件名(全部小写)。
 *
 * 这里的元素既会被 categorizeByFilename 用来识别附件,也会被搜索 glob 用来
 * 把这些文件加入文本搜索范围。
 */
export const KNOWN_TEXT_FILENAMES = new Set<string>([
  'dockerfile',
  'makefile',
  'gemfile',
  'rakefile',
  'procfile',
  'vagrantfile',
  'jenkinsfile',
  'cmakelists',
]);
