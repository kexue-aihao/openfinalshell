import { describe, expect, it } from 'vitest'
import { StringStream } from '@codemirror/language'
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
import type { StreamParser } from '@codemirror/language'
import {
  BASE_TOKENS,
  PROPERTIES_TOKENS,
  resolvesToTag
} from '@/features/editor/legacyTokens'

/**
 * 把每个 legacy 模式对着一段**真实形状**的样本跑一遍 tokenizer，断言它吐出的每一个
 * token 名都能经我们的 tokenTable 解析成一个 @lezer/highlight 标签。
 *
 * 这条护栏值钱的地方在于它是**行为**的而不是文本的：CM6 的 StreamLanguage 把 token 名
 * 当标签名直接查表，查不到就是"这一类词永远没有颜色"+ 一条 console.warn——
 * 而这两样都不会让构建失败、不会让类型检查失败、也不会让别的用例变红。
 * 它同时盯住三件会变的事：
 *  ① 我把某个模式加进 LANGUAGES 却忘了它吐的名字需要映射；
 *  ② @codemirror/legacy-modes 升级时改了某个 token 名；
 *  ③ 有人"顺手清理"把 tokenTable 里看着没人用的条目删掉。
 *
 * 样本必须有真实形状（注释、键值、块、字符串、数字都要出现），否则跑不到那些分支 ——
 * 一个空字符串样本能让这条用例永远绿。下面每条断言都会打印实际吐出的名字集合，
 * 于是它红的时候直接告诉你该往表里加什么。
 */

const SAMPLES: Record<string, { mode: StreamParser<unknown>; table: Record<string, unknown>; src: string }> = {
  shell: {
    mode: shell,
    table: BASE_TOKENS,
    src: [
      '#!/bin/bash',
      'set -euo pipefail',
      'NAME="${1:-world}"',
      'if [ -f /etc/os-release ]; then',
      '  echo "hello $NAME" | tr a-z A-Z',
      'fi',
      "for f in *.log; do rm -f -- \"$f\"; done"
    ].join('\n')
  },
  nginx: {
    mode: nginx,
    table: BASE_TOKENS,
    src: [
      'user www-data;',
      '# comment',
      'http {',
      '  include /etc/nginx/mime.types;',
      '  server {',
      '    listen 443 ssl;',
      '    server_name example.com;',
      '    location /api/ { proxy_pass http://127.0.0.1:8080; }',
      '  }',
      '}'
    ].join('\n')
  },
  properties: {
    mode: properties,
    table: PROPERTIES_TOKENS,
    src: [
      '# sshd 风格',
      '[mysqld]',
      'Port 22',
      'PermitRootLogin no',
      'max_connections = 500',
      'DB_URL=postgres://x',
      '; 分号注释'
    ].join('\n')
  },
  toml: {
    mode: toml,
    table: BASE_TOKENS,
    src: ['# c', '[server]', 'host = "0.0.0.0"', 'port = 8080', 'flags = [1, 2]'].join('\n')
  },
  dockerfile: {
    mode: dockerFile,
    table: BASE_TOKENS,
    src: [
      'FROM node:20-alpine AS build',
      '# c',
      'WORKDIR /app',
      'RUN npm ci && npm run build',
      'ENV NODE_ENV=production',
      'CMD ["node", "server.js"]'
    ].join('\n')
  },
  diff: {
    mode: diff,
    table: BASE_TOKENS,
    src: ['--- a/x.c', '+++ b/x.c', '@@ -1,3 +1,4 @@', '-old line', '+new line', ' context'].join('\n')
  },
  lua: { mode: lua, table: BASE_TOKENS, src: 'local t = {1,2}\nfunction f(x) return x + 1 end\n-- c\n' },
  perl: { mode: perl, table: BASE_TOKENS, src: '#!/usr/bin/perl\nuse strict;\nmy $x = "hi";\nprint "$x";\n' },
  python: {
    mode: python,
    table: BASE_TOKENS,
    src: '#!/usr/bin/env python3\nimport os\nclass A:\n    def f(self, n=1):\n        return {\'k\': n}\n'
  },
  javascript: {
    mode: javascript,
    table: BASE_TOKENS,
    src: 'const a = 1;\nfunction f(x) { return x + 1 }\n// c\nexport default f;\n'
  },
  xml: { mode: xml, table: BASE_TOKENS, src: '<?xml version="1.0"?>\n<!-- c -->\n<root attr="v"><child/>text</root>\n' },
  html: {
    mode: html,
    table: BASE_TOKENS,
    src: '<!doctype html>\n<html><head><title>t</title></head><body><p class="a">x</p></body></html>\n'
  },
  sql: { mode: standardSQL, table: BASE_TOKENS, src: '-- c\nSELECT id, name FROM users WHERE age > 18;\n' },
  css: {
    mode: css,
    table: BASE_TOKENS,
    src: '/* c */\n.a { color: #fff; margin: 0 auto; }\n@media (min-width: 1px) { .b::after { content: "x" } }\n'
  }
}

/** 把一段源码喂给模式，收集它吐出的所有 token 名 */
function tokensOf(mode: StreamParser<unknown>, src: string): Set<string> {
  const state = mode.startState ? mode.startState(2) : {}
  const seen = new Set<string>()
  for (const line of src.split('\n')) {
    if (line === '') {
      mode.blankLine?.(state, 2)
      continue
    }
    // (行文本, tabSize, indentUnit)。第 4 个参数是 overrideIndent，用不到
    const stream = new StringStream(line, 2, 2)
    // 兜一个上限：模式写错时 token() 可能不推进流，那会变成死循环而不是失败
    let guard = 0
    while (!stream.eol() && guard++ < 1000) {
      const before = stream.pos
      const tok = mode.token(stream, state)
      if (stream.pos === before) stream.next()
      if (tok) seen.add(tok)
    }
    expect(guard, '模式没有推进流，样本可能触发了死循环').toBeLessThan(1000)
  }
  return seen
}

describe('legacy 模式的 token 名都解析得出标签', () => {
  it.each(Object.keys(SAMPLES))('%s', (id) => {
    const { mode, table, src } = SAMPLES[id]
    const emitted = [...tokensOf(mode, src)].sort()

    // 反空转：样本必须真的触发出一批 token。样本写错（比如整段被当成一个字符串）
    // 会让"全都解析得出"变成空集上的真命题
    expect(emitted.length, `${id} 的样本一个 token 都没吐出来，这条用例在空转`).toBeGreaterThanOrEqual(3)

    const unresolved = emitted.filter((name) => !resolvesToTag(name, table as never))
    expect(
      unresolved,
      `${id} 吐出的这些 token 名解析不出标签 —— 这类词在编辑器里没有颜色，` +
        `而且每个都会打一条 console.warn。把它们加进 legacyTokens.ts。` +
        `（该模式本次吐出：${emitted.join(' ')}）`
    ).toEqual([])
  })
})

describe('tokenTable 本身', () => {
  /**
   * 表里每个条目都必须真的有模式在用。这条防的是相反方向的腐烂：
   * 升级 legacy-modes 之后某个名字不再被吐出，条目就成了误导后人的死代码。
   */
  it('没有多余条目（每个键都真的被某个模式吐出过）', () => {
    const allEmitted = new Set<string>()
    for (const { mode, src } of Object.values(SAMPLES)) {
      for (const tok of tokensOf(mode, src)) allEmitted.add(tok)
    }
    const unused = Object.keys(BASE_TOKENS).filter((k) => !allEmitted.has(k))
    expect(unused, '这些映射没有任何模式在用了（legacy-modes 升级后改了名？）').toEqual([])
  })

  it('properties 的 def 映到键名，而通用表映到"被定义的名字"', () => {
    // 同名不同义那一条：sshd_config 的左半边是键，不是函数名
    expect(PROPERTIES_TOKENS.def).not.toBe(BASE_TOKENS.def)
    expect(resolvesToTag('def', PROPERTIES_TOKENS as never)).toBe(true)
  })

  it('resolvesToTag 认修饰符写法，也认得出假名字', () => {
    expect(resolvesToTag('string')).toBe(true)
    expect(resolvesToTag('string.special')).toBe(true)
    expect(resolvesToTag('variableName.local')).toBe(true)
    // definition 是修饰符，单独用不是标签
    expect(resolvesToTag('definition')).toBe(false)
    expect(resolvesToTag('header')).toBe(false)
    expect(resolvesToTag('header', BASE_TOKENS as never)).toBe(true)
    expect(resolvesToTag('nope-not-a-tag')).toBe(false)
  })
})
