import { describe, expect, it } from 'vitest'
import { COMMAND_HISTORY_MAX_CHARS } from '@shared/constants'
import {
  captureCommand,
  extractCommand,
  PromptTracker,
  readLogicalLine,
  type BufferLike
} from '@/features/terminal/commandCapture'

/**
 * 命令历史的采集逻辑。这一层能在 node 里跑真代码，是因为 commandCapture 只认一个
 * **结构类型**的缓冲（BufferLike）而不是真的 xterm Terminal —— 测试环境没有 DOM，
 * 真 Terminal 起不来，而这几行切法正是最该被验的部分（切错一格就是把提示符
 * 或者半条命令存进一张持久化的表）。
 */

const COLS = 80

function fakeBuffer(
  rows: Array<string | { text: string; wrapped: boolean }>,
  opts: { cursorX: number; cursorY: number; type?: 'normal' | 'alternate'; baseY?: number } = {
    cursorX: 0,
    cursorY: 0
  }
): BufferLike {
  const normalized = rows.map((r) => (typeof r === 'string' ? { text: r, wrapped: false } : r))
  return {
    type: opts.type ?? 'normal',
    baseY: opts.baseY ?? 0,
    cursorX: opts.cursorX,
    cursorY: opts.cursorY,
    getLine: (y) => {
      const row = normalized[y]
      if (!row) return undefined
      return {
        isWrapped: row.wrapped,
        // 真 xterm 的行是定长的：不去尾时补空格到列宽。折行处少了这些空格，列号就会错位
        translateToString: (trimRight?: boolean) =>
          trimRight ? row.text.replace(/\s+$/, '') : row.text.padEnd(COLS, ' ')
      }
    }
  }
}

describe('提示符末尾列（promptCol）这条路', () => {
  it('bash：按列切，命令里有什么字符都不影响', () => {
    const line = 'root@web-01:~# echo a > b.txt'
    expect(extractCommand(line, 'root@web-01:~# '.length)).toBe('echo a > b.txt')
  })

  it('提示符里有 emoji / powerline 也照办（这正是不靠认提示符的理由）', () => {
    const line = '➜  ~ git commit -m "修好了"'
    expect(extractCommand(line, '➜  ~ '.length)).toBe('git commit -m "修好了"')
  })

  it('列号越界时不硬切，退回启发式', () => {
    // 缓冲滚动过头之类的场合会记到一个已经不成立的列号
    expect(extractCommand('root@h:~# ls', 999)).toBe('ls')
  })

  it('空命令（光敲回车）不记', () => {
    expect(extractCommand('root@h:~#', 'root@h:~# '.length)).toBeNull()
    expect(extractCommand('root@h:~# ', 'root@h:~# '.length)).toBeNull()
  })
})

describe('提示符启发式（量不到列号时）', () => {
  it('认 $ / # / %', () => {
    expect(extractCommand('ubuntu@ip-10-0-0-1:/var/log$ tail -f syslog', null)).toBe(
      'tail -f syslog'
    )
    expect(extractCommand('root@web-01:~# systemctl restart nginx', null)).toBe(
      'systemctl restart nginx'
    )
    expect(extractCommand('zhang@mac ~ % git status', null)).toBe('git status')
  })

  it('提示符里的 # 在命令之前，所以命令里再出现 # 也不会被切错', () => {
    expect(extractCommand('root@h:~# echo hi # 注释', null)).toBe('echo hi # 注释')
  })

  /**
   * 这一条是"为什么不认 `> `"的封条。认了它，下面这行（提示符不含 $/#/%）
   * 就会被切成 `b.txt` —— 一条错的命令进历史，比不进历史坏得多。
   */
  it('切不出来就不记，绝不把提示符或半条命令当命令', () => {
    expect(extractCommand('➜  ~ echo a > b.txt', null)).toBeNull()
    expect(extractCommand('PS C:\\> dir', null)).toBeNull()
  })
})

/**
 * 真实世界里的提示符形状。
 *
 * 这张表存在的理由：采集的两条路里，**只有退路认提示符**，而退路认得的只有 `$ `/`# `/`% `。
 * 主路（提示符列）与提示符长什么样无关，所以这里逐条标出"哪些形状只能靠主路"——
 * 那正是打包冒烟里 `ps1 exotic` 那一步在真 xterm 上验的东西。
 */
describe('真实提示符形状', () => {
  const cases: Array<{ 说明: string; line: string; cmd: string; 退路认得: boolean }> = [
    {
      说明: 'bash 默认（Debian/Ubuntu）',
      line: 'ubuntu@web-01:~/app$ npm run build',
      cmd: 'npm run build',
      退路认得: true
    },
    {
      说明: 'bash root',
      line: '[root@centos7 /etc/nginx]# nginx -t',
      cmd: 'nginx -t',
      退路认得: true
    },
    {
      说明: 'zsh 默认',
      line: 'zhang@mbp ~/src % cargo test',
      cmd: 'cargo test',
      退路认得: true
    },
    {
      说明: 'sh 极简',
      line: '$ id',
      cmd: 'id',
      退路认得: true
    },
    {
      说明: 'oh-my-zsh（robbyrussell）—— 没有 $ / # / %',
      line: '➜  app git:(main) ✗ git status',
      cmd: 'git status',
      退路认得: false
    },
    {
      说明: 'powerline 风格箭头',
      line: ' zhang  ~/work  kubectl get pods',
      cmd: 'kubectl get pods',
      退路认得: false
    },
    {
      说明: 'fish 默认',
      line: 'zhang@box ~/d/proj> make',
      cmd: 'make',
      退路认得: false
    }
  ]

  for (const c of cases) {
    it(`${c.说明}：主路（提示符列）一定切得对`, () => {
      const promptCol = c.line.length - c.cmd.length
      expect(extractCommand(c.line, promptCol)).toBe(c.cmd)
    })

    it(`${c.说明}：退路${c.退路认得 ? '认得' : '认不出（如实返回 null）'}`, () => {
      expect(extractCommand(c.line, null)).toBe(c.退路认得 ? c.cmd : null)
    })
  }
})

describe('两道内容守卫', () => {
  it('提示符那一段在问口令 → 整条不记', () => {
    const line = '[sudo] password for zhang: hunter2'
    expect(extractCommand(line, '[sudo] password for zhang: '.length)).toBeNull()
    expect(extractCommand('Enter passphrase for key: 我的口令', 26)).toBeNull()
    // 命令本身带 -p 是另一回事：那是一条真命令，记它是历史该做的（README 里写明了）
    expect(extractCommand('root@h:~# mysql -uroot -pxxx', null)).toBe('mysql -uroot -pxxx')
  })

  it('超长的一律丢（往终端里粘一整段脚本时它就是"一行"）', () => {
    const long = 'a'.repeat(COMMAND_HISTORY_MAX_CHARS + 1)
    expect(extractCommand(`root@h:~# ${long}`, null)).toBeNull()
    expect(extractCommand(`root@h:~# ${'b'.repeat(COMMAND_HISTORY_MAX_CHARS)}`, null)).toHaveLength(
      COMMAND_HISTORY_MAX_CHARS
    )
  })
})

describe('折行的命令要当成一行', () => {
  const rows = [
    { text: 'root@h:~# for i in 1 2 3; do echo "第 $i 遍"; done && echo 完事了 && sleep 1', wrapped: false },
    { text: '0 && date', wrapped: true }
  ]

  it('readLogicalLine 把 wrapped 行接起来并只在最后去尾空白', () => {
    const buf = fakeBuffer(rows, { cursorX: 9, cursorY: 1 })
    const line = readLogicalLine(buf)
    expect(line.startsWith('root@h:~# for i in')).toBe(true)
    expect(line.endsWith('0 && date')).toBe(true)
    // 第一行被补齐到列宽，所以拼接后总长 = 80 + 第二行长度
    expect(line).toHaveLength(COLS + '0 && date'.length)
  })

  it('光标在折行的第二行上，promptCol 仍然对得上第一行', () => {
    const buf = fakeBuffer(rows, { cursorX: 9, cursorY: 1 })
    const tracker = new PromptTracker()
    // 用户在第一行敲下第一个键时（光标在提示符末尾）
    tracker.noteKeystroke(fakeBuffer(rows, { cursorX: 'root@h:~# '.length, cursorY: 0 }))
    const command = captureCommand(buf, tracker)
    expect(command?.startsWith('for i in 1 2 3;')).toBe(true)
    expect(command?.endsWith('0 && date')).toBe(true)
  })
})

describe('全屏程序里一律不采集', () => {
  it('alternate buffer（vim/less/htop）直接返回 null', () => {
    const buf = fakeBuffer(['root@h:~# 这看着像命令'], {
      cursorX: 20,
      cursorY: 0,
      type: 'alternate'
    })
    const tracker = new PromptTracker()
    tracker.noteKeystroke(buf)
    expect(captureCommand(buf, tracker)).toBeNull()
    // 同一行在普通缓冲里是记得下的 —— 证明上面那条 null 真的来自这道守卫
    expect(captureCommand(fakeBuffer(['root@h:~# ls'], { cursorX: 12, cursorY: 0 }), tracker)).toBe(
      'ls'
    )
  })
})

describe('PromptTracker', () => {
  it('一行只记第一次按键时的列号（后面打的字会把光标推走）', () => {
    const tracker = new PromptTracker()
    const rows = ['root@h:~# ls -al']
    tracker.noteKeystroke(fakeBuffer(rows, { cursorX: 10, cursorY: 0 }))
    tracker.noteKeystroke(fakeBuffer(rows, { cursorX: 14, cursorY: 0 }))
    expect(tracker.promptColFor(fakeBuffer(rows, { cursorX: 16, cursorY: 0 }))).toBe(10)
  })

  it('换到新的一行（执行完出了新提示符）会重新记', () => {
    const tracker = new PromptTracker()
    const rows = ['root@h:~# ls', 'a.txt', 'root@long-host:/var/log# ']
    tracker.noteKeystroke(fakeBuffer(rows, { cursorX: 10, cursorY: 0 }))
    tracker.noteKeystroke(fakeBuffer(rows, { cursorX: 25, cursorY: 2 }))
    expect(tracker.promptColFor(fakeBuffer(rows, { cursorX: 27, cursorY: 2 }))).toBe(25)
  })

  /**
   * 这条守的是一个真会发生的错：点一条历史/快捷命令回填 → 光标被推到回填内容之后 →
   * 用户接着补几个字符 → 那次按键记下的列号在命令中间 → 只记下他补的那几个字符。
   * 所以程序写过的行标成不可信，逼采集退回启发式（能拿到整条命令）。
   */
  it('程序写过的行不可信 → promptColFor 返回 null，且此后的按键不会把它变回可信', () => {
    const tracker = new PromptTracker()
    const rows = ['root@h:~# df -h --si']
    tracker.noteProgrammaticWrite(fakeBuffer(rows, { cursorX: 10, cursorY: 0 }))
    tracker.noteKeystroke(fakeBuffer(rows, { cursorX: 15, cursorY: 0 }))
    expect(tracker.promptColFor(fakeBuffer(rows, { cursorX: 20, cursorY: 0 }))).toBeNull()
    // 退回启发式之后拿到的是**整条**命令，而不是用户后补的那截
    expect(captureCommand(fakeBuffer(rows, { cursorX: 20, cursorY: 0 }), tracker)).toBe('df -h --si')
  })

  it('还没见过任何按键时给 null（这一行第一个键就是回车）', () => {
    expect(new PromptTracker().promptColFor(fakeBuffer(['root@h:~#'], { cursorX: 9, cursorY: 0 }))).toBeNull()
  })
})
