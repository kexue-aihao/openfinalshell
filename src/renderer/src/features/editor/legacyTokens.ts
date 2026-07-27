import { type Tag, tags as t } from '@lezer/highlight'

/**
 * CM5 legacy 模式吐出的 token 名 → @lezer/highlight 的合法标签。
 *
 * **为什么需要这张表**（这是实测出来的，不是抄文档）：CM6 的 StreamLanguage 把模式吐的
 * token 名当作标签名**直接查表**（见 @codemirror/language 的 createTokenType：
 * `extra[part] || tags[part]`，`.` 是修饰符分隔符）。而 @codemirror/legacy-modes 里
 * 有一批名字压根不是合法标签。把我们用到的 14 个模式对着样本各跑一遍 tokenizer、
 * 收集实际吐出的名字、与标签表求差，得到 8 个：
 *
 *   def(出现在 6 个模式里)  variable(6)  attribute(3)  error(3)
 *   tag(3)  header(1)  property(1)  qualifier(1)
 *
 * 不映射的后果不是"少几种颜色"：xml/html 的标签与属性、properties 的键与 `[section]`、
 * nginx 里除已知指令之外的一切，全都不着色 —— sshd_config / my.cnf 这类文件
 * 恰好只剩注释有颜色，看起来就像这个功能没做。顺带还会给每个未知名字打一条 console.warn。
 *
 * **这张表与 cmSetup 分成两个文件是有意的**：cmSetup 会 import @codemirror/view，
 * 那个包在模块加载时就要摸 navigator/document；而这张表要能在 node 环境的单测里
 * 被真的跑一遍（test/renderer/legacyTokens.test.ts 把 tokenizer 跑过所有模式，
 * 断言每个吐出的名字都解析得出标签）。放在一起就只能改成源码文本护栏，弱得多。
 */
export const BASE_TOKENS: Record<string, Tag> = {
  // 代码类模式里 def 是"正在被定义的名字"（python 的函数名、js 的 const 名）
  def: t.definition(t.variableName),
  variable: t.variableName,
  attribute: t.attributeName,
  error: t.invalid,
  tag: t.tagName,
  property: t.propertyName,
  qualifier: t.modifier,
  header: t.heading
}

/**
 * properties 模式的 token 名与别处**同名不同义**，必须单独一张表：
 * 它把行首那半边叫 `def`（其实是键名）、把 `[section]` 叫 `header`、
 * 把 `=` 右边叫 `quote`（quote 恰好是合法标签 —— markdown 的引用块 —— 所以不用映射，
 * 但配色里要给它色，否则 sshd_config 的值那半边是没有颜色的）。
 *
 * 这条覆盖很关键：sshd_config / my.cnf / .env 是运维最常打开的东西，
 * 而用通用表的话它们的键会被着成"函数名"色，与真正的键名色不是一档。
 */
export const PROPERTIES_TOKENS: Record<string, Tag> = { ...BASE_TOKENS, def: t.propertyName }

/**
 * 判定一个 token 名能否被解析成标签 —— 与 createTokenType 同样的规则：
 * 以 `.` 分段，第一段必须是标签，其余段必须是修饰符。
 *
 * 导出它不是为了产品代码用（产品代码只需要那两张表），而是为了单测能对着
 * "模式实际吐出的名字"逐个判定，而不是我在测试里再写一遍这套规则。
 */
export function resolvesToTag(name: string, extra: Record<string, Tag> = {}): boolean {
  const parts = name.split('.')
  const head = extra[parts[0]] ?? (t as unknown as Record<string, unknown>)[parts[0]]
  if (head === undefined || typeof head === 'function') return false
  return parts
    .slice(1)
    .every((p) => typeof (t as unknown as Record<string, unknown>)[p] === 'function')
}
