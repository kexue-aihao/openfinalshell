import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { json } from '@codemirror/lang-json'
import { yaml } from '@codemirror/lang-yaml'
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentUnit,
  syntaxHighlighting,
  type StreamParser
} from '@codemirror/language'
import { css } from '@codemirror/legacy-modes/mode/css'
import { diff } from '@codemirror/legacy-modes/mode/diff'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { javascript } from '@codemirror/legacy-modes/mode/javascript'
import { lua } from '@codemirror/legacy-modes/mode/lua'
import { nginx } from '@codemirror/legacy-modes/mode/nginx'
import { perl } from '@codemirror/legacy-modes/mode/perl'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { python } from '@codemirror/legacy-modes/mode/python'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { standardSQL } from '@codemirror/legacy-modes/mode/sql'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { html, xml } from '@codemirror/legacy-modes/mode/xml'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  scrollPastEnd
} from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import type { LanguageId } from './editorPolicy'
import { BASE_TOKENS, PROPERTIES_TOKENS } from './legacyTokens'

/**
 * CodeMirror 6 的装配处 —— 扩展集、语法色、主题。
 *
 * 三条贯穿整个文件的决定：
 *
 * **① 颜色一律写成 `var(--ofs-*)`，不写具体色值。** 于是切主题（深/浅）、换强调色
 * 都不需要重建 EditorView，也不需要在这里放一份第二套配色。切主题时 applyCssVars
 * 改 :root 上的变量，编辑器跟着变 —— 零 JS 参与。
 *
 * **② 不给 EditorView.theme 传 `dark` 标志。** 传了就得在切主题时 reconfigure，
 * 而那个标志的唯一作用是挑 CM 自带 baseTheme 的深/浅变体 —— 我们把它会挑的那几项
 * （选中、光标、gutter、面板）全部显式覆盖了，优先级也比 baseTheme 高。
 *
 * **③ legacy 模式必须带 tokenTable。** 这条是实测出来的，不是抄文档：CM6 把 CM5 模式
 * 吐的 token 名当作 @lezer/highlight 的**标签名**直接查表（见 @codemirror/language 的
 * createTokenType），而 legacy 模式里有一批名字压根不是合法标签。把 14 个模式对着样本
 * 各跑一遍 tokenizer 收集实际吐出的名字，与标签表求差，得到 8 个：
 *
 *   def(6 个模式)  variable(6)  attribute(3)  error(3)  tag(3)  header(1)  property(1)  qualifier(1)
 *
 * 不映射的后果不是"少几种颜色"：xml/html 的标签与属性、properties 的键与 [section]、
 * nginx 里除已知指令之外的一切，全部不着色 —— 而 sshd_config / my.cnf 这类文件
 * 恰好只剩注释有颜色，看起来就像这个功能没做。顺带还会给每个未知名字打一条 console.warn。
 */

// ---------------------------------------------------------------------------
// 语言
// ---------------------------------------------------------------------------

/**
 * legacy 模式一律带 tokenTable（那两张表与"为什么必须有"在 legacyTokens.ts，
 * 它不依赖 @codemirror/view，所以能在单测里把 tokenizer 真跑一遍来验证）。
 *
 * 默认参数写成 BASE_TOKENS 而不是可选：漏传一个模式就是那个语言静默不着色，
 * 而这种"少了一个参数"的错在评审时看不出来。
 */
const legacy = (parser: StreamParser<unknown>, tokenTable = BASE_TOKENS): Extension =>
  StreamLanguage.define({ ...parser, tokenTable })

/** 语言 id → 扩展。plain 故意没有条目：拿不到语言时就是不着色，而不是猜一个 */
const LANGUAGES: Partial<Record<LanguageId, () => Extension>> = {
  // json / yaml 用真解析器（有语法树）：它们是配置文件里结构最重的两种，
  // 折叠、括号匹配、键名精确着色都要靠树。别的语言用 StreamLanguage 换字节，
  // 代价是没有语法树 —— 结构折叠与括号匹配在那些语言里不生效，这是清楚的取舍
  json: () => json(),
  yaml: () => yaml(),
  shell: () => legacy(shell),
  nginx: () => legacy(nginx),
  properties: () => legacy(properties, PROPERTIES_TOKENS),
  toml: () => legacy(toml),
  dockerfile: () => legacy(dockerFile),
  diff: () => legacy(diff),
  lua: () => legacy(lua),
  perl: () => legacy(perl),
  python: () => legacy(python),
  javascript: () => legacy(javascript),
  xml: () => legacy(xml),
  html: () => legacy(html),
  sql: () => legacy(standardSQL),
  css: () => legacy(css)
}

export function languageExtension(id: LanguageId): Extension {
  return LANGUAGES[id]?.() ?? []
}

// ---------------------------------------------------------------------------
// 语法配色
// ---------------------------------------------------------------------------

/**
 * 标签 → CSS 变量。一个色位挂多个标签是常态：语言不同、粒度不同，
 * 但用户想看到的层次只有那 15 档。
 */
const ofsHighlight = HighlightStyle.define([
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
    color: 'var(--ofs-syn-comment)',
    fontStyle: 'italic'
  },
  {
    tag: [
      t.keyword,
      t.controlKeyword,
      t.moduleKeyword,
      t.definitionKeyword,
      t.operatorKeyword,
      t.modifier,
      t.self
    ],
    color: 'var(--ofs-syn-keyword)'
  },
  {
    tag: [t.string, t.docString, t.character, t.special(t.string), t.regexp, t.quote],
    color: 'var(--ofs-syn-string)'
  },
  { tag: [t.number, t.integer, t.float, t.unit], color: 'var(--ofs-syn-number)' },
  // constant 是**修饰符**不是标签（写 t.constant 会被类型系统拦下来，别改回去）
  {
    tag: [t.bool, t.null, t.atom, t.literal, t.constant(t.variableName), t.constant(t.name)],
    color: 'var(--ofs-syn-constant)'
  },
  {
    tag: [t.propertyName, t.definition(t.propertyName), t.labelName],
    color: 'var(--ofs-syn-property)'
  },
  {
    tag: [t.variableName, t.special(t.variableName), t.local(t.variableName)],
    color: 'var(--ofs-syn-variable)'
  },
  {
    tag: [
      t.function(t.variableName),
      t.function(t.propertyName),
      t.definition(t.variableName),
      t.macroName
    ],
    color: 'var(--ofs-syn-function)'
  },
  {
    tag: [t.typeName, t.className, t.namespace, t.standard(t.variableName)],
    color: 'var(--ofs-syn-type)'
  },
  {
    tag: [
      t.operator,
      t.derefOperator,
      t.arithmeticOperator,
      t.logicOperator,
      t.compareOperator,
      t.definitionOperator,
      t.typeOperator,
      t.controlOperator,
      t.updateOperator,
      t.bitwiseOperator
    ],
    color: 'var(--ofs-syn-operator)'
  },
  {
    tag: [
      t.punctuation,
      t.separator,
      t.bracket,
      t.angleBracket,
      t.squareBracket,
      t.paren,
      t.brace,
      t.contentSeparator
    ],
    color: 'var(--ofs-syn-punctuation)'
  },
  { tag: [t.tagName], color: 'var(--ofs-syn-tag)' },
  { tag: [t.attributeName], color: 'var(--ofs-syn-attribute)' },
  { tag: [t.attributeValue], color: 'var(--ofs-syn-string)' },
  { tag: [t.invalid], color: 'var(--ofs-syn-invalid)', textDecoration: 'underline wavy' },
  {
    tag: [t.meta, t.documentMeta, t.annotation, t.processingInstruction, t.escape, t.url, t.link],
    color: 'var(--ofs-syn-meta)'
  },
  // [section] / ini 的节名 / markdown 标题：加粗比换色更能表达"这是一段的开头"
  {
    tag: [t.heading, t.heading1, t.heading2, t.heading3],
    color: 'var(--ofs-syn-keyword)',
    fontWeight: '600'
  },
  { tag: [t.strong], fontWeight: '600' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strikethrough], textDecoration: 'line-through' },
  // diff：加行/删行用界面的成功/错误色，与传输列表里"成功/失败"是同一套语义
  { tag: [t.inserted], color: 'var(--ofs-success)' },
  { tag: [t.deleted], color: 'var(--ofs-error)' },
  { tag: [t.changed], color: 'var(--ofs-warning)' }
])

// ---------------------------------------------------------------------------
// 容器主题
// ---------------------------------------------------------------------------

/**
 * 要显形的**不可见字符**码点区间（含端点）。
 *
 * 这一条对中文用户群不是装饰而是刚需：全角空格（U+3000）与不换行空格（U+00A0）
 * 从输入法或网页里复制粘贴进 YAML / nginx.conf 是极常见的事，而它们看起来和普通空格
 * 一模一样，服务器那边只会给一条语法错误。CM 自带的 specialChars 不含这两个
 * （它盯的是控制字符与双向文本控制符），所以这里把默认那一串抄过来再补上它们。
 *
 * 写成码点数组、再拼成正则，而不是直接写一个带 \\u 转义的正则字面量：
 * 那一串转义在源码里是一团没法核对的东西，而且**一旦哪个环节把转义当成真字符处理**，
 * 文件里就会落进字面控制字节（NUL 尤其恶劣：整份文件从此被当成二进制）。
 * 这样写还能给每个区间写注释说明它是什么。
 *
 * 刻意不含 0x09（制表符）与 0x0a（换行）：制表符在配置文件里是合法且常见的缩进，
 * 标出来只会满屏噪声；换行根本走不到这里（按行渲染）。
 */
const CONFUSABLE_RANGES: Array<[number, number]> = [
  [0x00, 0x08], // 控制字符（跳过 0x09 制表符、0x0a 换行）
  [0x0b, 0x1f],
  [0x7f, 0x9f], // DEL 与 C1 控制字符
  [0xa0, 0xa0], // NBSP —— 从网页复制粘贴的头号杀手
  [0xad, 0xad], // 软连字符
  [0x61c, 0x61c], // 阿拉伯字母标记
  [0x200b, 0x200f], // 零宽空格 / 零宽连接符 / 左右标记
  [0x2028, 0x2029], // 行/段分隔符
  [0x202d, 0x202e], // 双向覆盖（Trojan Source 那一类）
  [0x2060, 0x2064], // 词连接符与不可见运算符
  [0x2066, 0x2067],
  [0x2069, 0x2069],
  [0x3000, 0x3000], // 全角空格 —— 中文输入法下的头号杀手
  [0xfeff, 0xfeff], // 夹在文件中间的 BOM
  [0xfff9, 0xfffc] // 注释字符
]

const codePoint = (cp: number): string => `\\u{${cp.toString(16)}}`
const CONFUSABLE_CHARS = new RegExp(
  `[${CONFUSABLE_RANGES.map(([lo, hi]) =>
    lo === hi ? codePoint(lo) : `${codePoint(lo)}-${codePoint(hi)}`
  ).join('')}]`,
  // u 标志是必须的：\\u{...} 这种写法只在 unicode 模式下被认成码点转义
  'gu'
)

const ofsEditorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13px',
    backgroundColor: 'var(--ofs-ed-bg)',
    color: 'var(--ofs-ed-fg)'
  },
  // 等宽字体跟着终端那份设置走？—— 不跟。终端字体是用户为"等宽 + Powerline 图标"挑的，
  // 而代码区还要显示中文注释：这里固定一串以 CJK 覆盖为准的栈，
  // 缺字回落到系统字体也不会把行高撑歪
  '.cm-scroller': {
    fontFamily:
      'Consolas, "Cascadia Mono", "Sarasa Mono SC", "Microsoft YaHei Mono", "Courier New", monospace',
    lineHeight: '1.55'
  },
  '.cm-content': { caretColor: 'var(--ofs-ed-cursor)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ofs-ed-cursor)', borderLeftWidth: '2px' },
  // 只读时把光标藏掉：一个在只读文档上闪的插入符是纯粹的误导
  // （键盘导航与 Ctrl+F 仍然可用，那才是查看器要的）。片 3 可编辑之后这条自然失效
  '&[data-ofs-readonly="1"] .cm-cursor': { display: 'none' },
  '.cm-selectionBackground, .cm-content ::selection, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--ofs-ed-selection)'
  },
  '.cm-activeLine': { backgroundColor: 'var(--ofs-ed-active-line)' },
  '.cm-gutters': {
    backgroundColor: 'var(--ofs-ed-gutter-bg)',
    color: 'var(--ofs-ed-gutter-fg)',
    border: 'none',
    borderRight: '1px solid var(--ofs-border)'
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--ofs-ed-active-line)',
    color: 'var(--ofs-ed-gutter-active-fg)'
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--ofs-bg-active)',
    color: 'var(--ofs-ed-fold-placeholder)',
    border: '1px solid var(--ofs-border)',
    borderRadius: '3px',
    padding: '0 4px',
    margin: '0 2px'
  },
  '.cm-specialChar': {
    color: 'var(--ofs-ed-special-char)',
    // 加个底色，否则一个红色小点在满屏代码里仍然容易被漏掉
    backgroundColor: 'color-mix(in srgb, var(--ofs-ed-special-char) 18%, transparent)',
    borderRadius: '2px'
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--ofs-ed-selection-match)' },
  '.cm-searchMatch': {
    backgroundColor: 'var(--ofs-ed-search-match)',
    outline: '1px solid color-mix(in srgb, var(--ofs-warning) 60%, transparent)'
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'var(--ofs-ed-search-match-active)'
  },
  '.cm-matchingBracket, .cm-nonmatchingBracket': {
    backgroundColor: 'var(--ofs-bg-active)',
    outline: '1px solid var(--ofs-border-strong)'
  },
  // 查找面板：CM 自带那套控件默认是浏览器原生样式，在深色主题下白得刺眼
  '.cm-panels': {
    backgroundColor: 'var(--ofs-bg-elevated)',
    color: 'var(--ofs-text-1)',
    borderBottom: '1px solid var(--ofs-border)'
  },
  '.cm-panel.cm-search': { padding: '6px 8px', fontSize: '12px' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label': {
    fontSize: '12px',
    color: 'var(--ofs-text-1)'
  },
  /*
   * 认 CM 自己的类名（.cm-textfield / .cm-button），**不能**写 input[type=text] ——
   * 查找面板里那个输入框根本没有 type 属性（`<input class="cm-textfield" name="search">`），
   * 按类型选择器一条都命中不了，于是整个面板留着浏览器原生外观：
   * 深色主题下是一块刺眼的白。这是打包冒烟那一步把 panels 的 innerHTML 打出来才发现的，
   * 在开发模式下我一次都没打开过查找条。
   */
  '.cm-panel.cm-search input.cm-textfield': {
    backgroundColor: 'var(--ofs-bg-panel)',
    border: '1px solid var(--ofs-border)',
    borderRadius: '4px',
    padding: '2px 6px',
    outline: 'none'
  },
  '.cm-panel.cm-search input.cm-textfield:focus': { borderColor: 'var(--ofs-accent)' },
  '.cm-panel.cm-search .cm-button': {
    backgroundColor: 'var(--ofs-bg-panel)',
    backgroundImage: 'none',
    border: '1px solid var(--ofs-border)',
    borderRadius: '4px',
    padding: '2px 8px',
    cursor: 'pointer'
  },
  '.cm-panel.cm-search .cm-button:hover': { backgroundColor: 'var(--ofs-bg-hover)' },
  '.cm-panel.cm-search [name=close]': {
    color: 'var(--ofs-text-2)',
    cursor: 'pointer',
    fontSize: '16px',
    background: 'none',
    border: 'none'
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--ofs-bg-elevated)',
    border: '1px solid var(--ofs-border)',
    color: 'var(--ofs-text-1)'
  }
})

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

/**
 * 两个隔间（Compartment）。用隔间而不是重建 EditorView：重建会丢掉滚动位置、
 * 选区、折叠状态与撤销历史 —— 而"切一下编码"或"改一下只读"本不该让用户回到文件开头。
 */
export const languageConf = new Compartment()
export const readOnlyConf = new Compartment()

/**
 * 只读那一组。只用 EditorState.readOnly（挡住所有改文档的事务），
 * **不**用 EditorView.editable.of(false)：后者会把 contentEditable 关掉，
 * 于是键盘导航与 Ctrl+F 全都进不来 —— 而"能翻能搜"正是查看器的全部意义。
 * 那个会闪的插入符由 CSS 藏掉（见上面的 data-ofs-readonly）。
 */
export function readOnlyExtension(readOnly: boolean): Extension {
  return [EditorState.readOnly.of(readOnly)]
}

export function baseExtensions(): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    highlightSpecialChars({ specialChars: CONFUSABLE_CHARS }),
    drawSelection(),
    rectangularSelection(),
    crosshairCursor(),
    // 最后一行能滚到中间，否则文件末尾永远贴在窗口底边、看着像被截断了
    scrollPastEnd(),
    foldGutter(),
    bracketMatching(),
    indentUnit.of('  '),
    syntaxHighlighting(ofsHighlight),
    // top: true —— 查找条出现在顶部。放底部会和状态条挤在一起
    search({ top: true }),
    highlightSelectionMatches(),
    /**
     * 撤销历史。**只读那一片漏了这一条**（`history()` 不装的话 `historyKeymap` 是空转，
     * 而 `defaultKeymap` 里并不含撤销）—— 只读时没人按 Ctrl+Z 所以没暴露，
     * 一旦可写就是不可接受的：改错一行没法退回去。
     *
     * 装在 baseExtensions 里而不是只在可写时装：历史是**每份 state 各自一份**的，
     * 而只读与可写之间靠 readOnlyConf 切（不换 state）—— 装在隔间里的话，
     * 切一次只读就把历史清空了。只读时 EditorState.readOnly 已经挡住一切改文档的事务，
     * 历史自然是空的，白装一个不花钱。
     */
    history(),
    /**
     * 顺序有讲究：
     *  - searchKeymap 在最前，否则 defaultKeymap 里的 Mod-d 之类会先吃掉按键；
     *  - indentWithTab 放在 defaultKeymap **之后**，因为它要覆盖 Tab 的默认行为。
     *
     * indentWithTab 的代价要说清：Tab 从此不再把焦点移出编辑器。加它是因为
     * "在代码编辑器里按 Tab 却跳走"更糟（YAML 缩进就是靠它），而这一格有别的出口
     * （鼠标、Ctrl+Tab 切会话标签）。**这是个已知的键盘可达性折衷**，不是没想到。
     */
    keymap.of([...searchKeymap, ...foldKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
    ofsEditorTheme
  ]
}
