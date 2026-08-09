import { describe, expect, it } from 'vitest'
import { applyCd, normalizePosix, parseCdTarget } from '../../src/renderer/src/features/sftp/pathSync'

describe('parseCdTarget：从命令里解析 cd 目标', () => {
  it('普通形态', () => {
    expect(parseCdTarget('cd /var/log')).toBe('/var/log')
    expect(parseCdTarget('cd ..')).toBe('..')
    expect(parseCdTarget('cd ./x')).toBe('./x')
    expect(parseCdTarget('  cd   logs  ')).toBe('logs')
  })

  it('无参 cd → 回 home（用 ~ 表示，交给 applyCd 解析）', () => {
    expect(parseCdTarget('cd')).toBe('~')
    expect(parseCdTarget('cd  ')).toBe('~')
    expect(parseCdTarget('cd ~')).toBe('~')
    expect(parseCdTarget('cd ~/logs')).toBe('~/logs')
  })

  it('带引号与转义空格的路径', () => {
    expect(parseCdTarget('cd "my dir"')).toBe('my dir')
    expect(parseCdTarget("cd '/opt/a b'")).toBe('/opt/a b')
    expect(parseCdTarget('cd my\\ dir')).toBe('my dir')
  })

  it('复合命令只看第一段；cd 不在第一段就不算', () => {
    expect(parseCdTarget('cd /tmp && ls -la')).toBe('/tmp')
    expect(parseCdTarget('cd /tmp; ls')).toBe('/tmp')
    expect(parseCdTarget('cd /tmp | cat')).toBe('/tmp')
    expect(parseCdTarget('ls && cd /tmp')).toBeNull()
    // 引号里的分隔符不许当分隔符切
    expect(parseCdTarget('cd "a;b"')).toBe('a;b')
  })

  it('cd 的选项跳过；-- 后照常取目标', () => {
    expect(parseCdTarget('cd -P /srv')).toBe('/srv')
    expect(parseCdTarget('cd -- -weird-dir')).toBe('-weird-dir')
  })

  it('静态推导不了的一律 null：cd -、$VAR、反引号', () => {
    expect(parseCdTarget('cd -')).toBeNull()
    expect(parseCdTarget('cd $HOME/logs')).toBeNull()
    expect(parseCdTarget('cd "$DIR"')).toBeNull()
    expect(parseCdTarget('cd `pwd`/x')).toBeNull()
  })

  it('不是 cd 的命令一律 null（cdx 这种前缀相同的也不许误认）', () => {
    expect(parseCdTarget('ls -la')).toBeNull()
    expect(parseCdTarget('cdx /tmp')).toBeNull()
    expect(parseCdTarget('echo cd /tmp')).toBeNull()
  })
})

describe('applyCd：目标应用到当前目录', () => {
  it('绝对路径直接规范化', () => {
    expect(applyCd('/root', '/var/log/', null)).toBe('/var/log')
    expect(applyCd('/root', '/a/./b/../c', null)).toBe('/a/c')
  })

  it('相对路径基于 cwd', () => {
    expect(applyCd('/var/www', 'logs', null)).toBe('/var/www/logs')
    expect(applyCd('/var/www', '..', null)).toBe('/var')
    expect(applyCd('/var/www', '../../etc', null)).toBe('/etc')
    expect(applyCd('/', '..', null)).toBe('/')
  })

  it('~ 类目标：有 home 才解析，没有就放弃；~user 永远放弃', () => {
    expect(applyCd('/tmp', '~', '/home/me')).toBe('/home/me')
    expect(applyCd('/tmp', '~/logs', '/home/me')).toBe('/home/me/logs')
    expect(applyCd('/tmp', '~', null)).toBeNull()
    expect(applyCd('/tmp', '~/logs', null)).toBeNull()
    expect(applyCd('/tmp', '~root', '/home/me')).toBeNull()
  })

  it('cwd 未初始化（非绝对路径）时相对目标放弃', () => {
    expect(applyCd('', 'logs', null)).toBeNull()
  })
})

describe('normalizePosix', () => {
  it('去重斜杠/尾斜杠，.. 越过根停在根', () => {
    expect(normalizePosix('/a//b/')).toBe('/a/b')
    expect(normalizePosix('/../..')).toBe('/')
    expect(normalizePosix('/')).toBe('/')
  })
})
