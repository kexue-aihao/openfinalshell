import { describe, expect, it } from 'vitest'
import { buildFrame, buildStaticFrame, SENTINEL, splitSections } from '../../src/main/monitor/script'

describe('buildFrame 的 ps 命令切换', () => {
  const base = { withDf: true, withPs: true, hasTimeout: true }

  it('procps 可用：走 -eo --sort（既有行为）', () => {
    const frame = buildFrame(1, { ...base, hasPsSort: true })
    expect(frame).toContain('ps -eo pid,pcpu,pmem,comm --sort=-pcpu')
    expect(frame).not.toContain('ps aux')
  })

  it('procps 不可用：退到 POSIX 管线，帧里不许再出现 --sort', () => {
    const frame = buildFrame(1, { ...base, hasPsSort: false })
    expect(frame).toContain('ps aux')
    // --sort 是 procps 专属 —— BusyBox 上它报错且 stderr 被吞，正是这次要修的静默失效
    expect(frame).not.toContain('--sort')
  })

  it('withPs=false 时两种模式都不带 ps', () => {
    for (const hasPsSort of [true, false]) {
      const frame = buildFrame(1, { ...base, withPs: false, hasPsSort })
      expect(frame).not.toContain('ps ')
    }
  })
})

describe('buildStaticFrame 的能力探测', () => {
  it('带 HASPSSORT 探测段，且用真实选项集探（command -v ps 不够，BusyBox 也有 ps）', () => {
    const frame = buildStaticFrame()
    expect(frame).toContain(SENTINEL.section('HASPSSORT'))
    expect(frame).toMatch(/ps -eo pid,pcpu,pmem,comm --sort=-pcpu >\/dev\/null 2>&1 && echo yes \|\| echo no/)
  })

  it('段名只能是大写字母 —— splitSections 的正则认不出带下划线/数字的段名', () => {
    // 这条护的是文件头警告的那个坑：HAS_PS_SORT 这类名字不报错、静默并进上一段
    const frame = buildStaticFrame()
    const names = [...frame.matchAll(/@@OFS:([A-Za-z0-9_]+)@@/g)]
      .map((m) => m[1])
      .filter((n) => !/^(BEGIN|END)/.test(n))
    for (const name of names) {
      expect(name).toMatch(/^[A-Z]+$/)
    }
    // 且每个段名都能被 splitSections 真的切出来
    const body = frame.replace(/^echo "@@OFS:BEGIN:0@@"\n/, '').replace(/echo "@@OFS:END:0@@"\n?$/, '')
    const echoed = body.replace(/^echo "(@@OFS:[A-Z]+@@)"$/gm, '$1')
    const sections = splitSections(echoed)
    for (const name of names) {
      expect(sections.has(name), `section ${name} 应能被切出`).toBe(true)
    }
  })
})
