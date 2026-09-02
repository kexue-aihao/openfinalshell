/**
 * 语法高亮的语义色位。
 *
 * 刻意按**语义**而不是按语言分：15 个位子要同时招待 nginx.conf、docker-compose.yml、
 * 一段 bash 和一份 JSON，按语言给色会立刻变成"每加一种语言就加一批变量"。
 *
 * `property` 这个位子对本项目**特别重要**，别按"随便一种标识符"对待：
 * 运维打开的东西九成是 key/value —— JSON 的键、YAML 的键、sshd_config 与 my.cnf 的
 * 左半边。它是这类文件里唯一的结构信号，所以它得和 `string` 明显区分开，
 * 不然一屏 `key: "value"` 会糊成一种颜色。
 */
export interface SyntaxPalette {
  comment: string
  keyword: string
  string: string
  number: string
  /** true / false / null / 原子量、以及 shell 里的特殊变量 */
  constant: string
  /** JSON/YAML/ini 的键名 —— 配置文件里最该被看见的东西 */
  property: string
  variable: string
  function: string
  type: string
  operator: string
  punctuation: string
  /** XML/HTML 标签名 */
  tag: string
  /** XML/HTML 属性名 */
  attribute: string
  /** 词法错误。语言用 StreamLanguage（legacy 模式）时基本不出现 */
  invalid: string
  /** 预处理指令、shebang、YAML 的 --- 分隔符这类"关于文件本身"的东西 */
  meta: string
}

/**
 * 编辑器容器自己的颜色（不属于语法着色）。
 *
 * 与 `ui.*` 分开而不是复用：代码区的正文色刻意比界面文字**暗一档**
 * （One Dark 的 #abb2bf vs 界面的 #e6e8eb）—— 满屏等宽字用界面那个亮度会发晃，
 * 而语法色需要在它之上还能拉开层次。这不是抄配色抄漏了，是有意的。
 */
export interface EditorPalette {
  bg: string
  fg: string
  gutterBg: string
  gutterFg: string
  gutterActiveFg: string
  activeLine: string
  selection: string
  /** highlightSelectionMatches：与当前选中内容相同的其他片段 */
  selectionMatch: string
  searchMatch: string
  searchMatchActive: string
  cursor: string
  foldPlaceholder: string
  /** 全角空格 / NBSP 的显形标记。刻意用告警色，见 cmSetup 里的说明 */
  specialChar: string
}

export interface OfsTheme {
  id: 'dark' | 'light'
  ui: {
    bgBase: string
    bgPanel: string
    bgElevated: string
    bgHover: string
    bgActive: string
    /** 半透明外壳、导航栏和浮层的正常表面 */
    glassSurface: string
    /** 弹窗等需要更明确层级的玻璃表面 */
    glassSurfaceStrong: string
    /** 禁用透明效果或不支持 backdrop-filter 时的实体回退 */
    solidSurface: string
    border: string
    borderStrong: string
    glassBorder: string
    textPrimary: string
    textSecondary: string
    textDisabled: string
    success: string
    warning: string
    error: string
    shadowPanel: string
    shadowModal: string
  }
  syntax: SyntaxPalette
  editor: EditorPalette
  /** 该 UI 主题下 terminal.themeId === 'auto' 时使用的终端配色 */
  terminalThemeId: string
}
