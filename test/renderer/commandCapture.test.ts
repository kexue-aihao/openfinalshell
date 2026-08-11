import { describe, expect, it } from 'vitest'
import { COMMAND_HISTORY_MAX_CHARS } from '@shared/constants'
import {
  captureSubmitted,
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

/**
 * 回车之后的缓冲：命令行**留在原处**，光标落到它下面一行。
 * 这就是 onLineFeed 触发那一刻的真实形态（shell 回显完命令、再回显换行）。
 */
function afterEnter(buf: BufferLike): BufferLike {
  return { ...buf, cursorX: 0, cursorY: buf.cursorY + 1 }
}

/**
 * 完整走一遍生产里的三步：回车时快照提示符列 → 追踪器复位 → 换行到达时采集。
 * 测试都经它，才不会写成"用一个生产里不存在的时机去断言"。
 */
function submitAndCapture(tracker: PromptTracker, buf: BufferLike): string | null {
  const snap = tracker.snapshot()
  tracker.noteSubmit()
  return captureSubmitted(afterEnter(buf), snap)
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
    const command = submitAndCapture(tracker, buf)
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
    expect(submitAndCapture(tracker, buf)).toBeNull()
    // 同一行在普通缓冲里是记得下的 —— 证明上面那条 null 真的来自这道守卫
    expect(submitAndCapture(tracker, fakeBuffer(['root@h:~# ls'], { cursorX: 12, cursorY: 0 }))).toBe(
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
    expect(submitAndCapture(tracker, fakeBuffer(rows, { cursorX: 20, cursorY: 0 }))).toBe('df -h --si')
  })

  it('还没见过任何按键时给 null（这一行第一个键就是回车）', () => {
    expect(new PromptTracker().promptColFor(fakeBuffer(['root@h:~#'], { cursorX: 9, cursorY: 0 }))).toBeNull()
  })
})

/**
 * **行号会被复用** —— 这一组守的是一个真出过的线上缺陷（cd 跟随"时好时坏"）。
 *
 * 行号是 `baseY + cursorY`，不随时间单调：xterm 的 scrollback 一满，ybase 就不再增长、
 * 行改为环形复用；`clear()` 直接把 ybase/y 归零。于是**此后每个新提示符都在同一个绝对行号上**。
 * 当年只按行号判断"还是那一行"，于是 promptCol 冻结在第一次测到的那一列 ——
 * 而 PS1 带 cwd，一 `cd` 长度就变，按旧列切出来的是提示符残片，
 * 于是命令历史被污染、SFTP 的 cd 跟随（parseCdTarget 拿残片得 null）静默失效。
 *
 * 现有的 74 条护栏一条都没抓到它，因为**没有一条构造过"同一个绝对行号上的两个不同提示符"**。
 */
/**
 * **回显赛跑** —— 这一组守的是线上真事故：用户敲 `cd /etc/v2node`，SFTP 却去读
 * `/etc/v2n`，服务器回 "No such file"，界面只闪一下就弹回去。
 *
 * 原因是采集时机：屏幕上的字全靠服务器回显，本地不回显。在回车 keydown 那一刻读屏，
 * 最后几个字符还在路上；按 Tab 让服务器补全时更是必然还没回来。
 * 所以采集必须等到**换行到达**——服务器按序回显：先补完字符，再回显换行。
 */
describe('回车与回显赛跑：必须等换行到达才采集', () => {
  it('回车那刻屏幕还差几个字符，换行到达后采到的是完整命令', () => {
    const tracker = new PromptTracker()
    const PROMPT = 'root@host:/etc# '
    // 用户敲第一个键时量到提示符列
    tracker.noteKeystroke(fakeBuffer([PROMPT], { cursorX: PROMPT.length, cursorY: 0 }))
    const snap = tracker.snapshot()

    // 回车那一刻：服务器只回显到 v2n（尾巴 "ode" 还在路上，或 Tab 补全还没回来）
    const atKeydown = fakeBuffer([`${PROMPT}cd /etc/v2n`], { cursorX: 27, cursorY: 0 })
    // 旧做法在这一刻读屏 —— 会采到被截断的命令（这正是事故现场）
    expect(extractCommand(readLogicalLine(atKeydown), snap.col)).toBe('cd /etc/v2n')

    // 换行到达时：剩下的字符已经回显完，光标落到下一行
    const atLineFeed = fakeBuffer([`${PROMPT}cd /etc/v2node`], { cursorX: 0, cursorY: 1 })
    expect(captureSubmitted(atLineFeed, snap)).toBe('cd /etc/v2node')
  })

  it('Tab 补全把整行都改了，也照样采到补全后的样子', () => {
    const tracker = new PromptTracker()
    const PROMPT = 'root@host:~# '
    tracker.noteKeystroke(fakeBuffer([PROMPT], { cursorX: PROMPT.length, cursorY: 0 }))
    const snap = tracker.snapshot()
    const atLineFeed = fakeBuffer([`${PROMPT}systemctl restart nginx.service`], {
      cursorX: 0,
      cursorY: 1
    })
    expect(captureSubmitted(atLineFeed, snap)).toBe('systemctl restart nginx.service')
  })

  it('提交后的折行命令：从光标上方那一行往上收，整条都要', () => {
    const rows = [
      { text: 'root@h:~# for i in 1 2 3; do echo "第 $i 遍"; done && echo 完事了 && sleep 1', wrapped: false },
      { text: '0 && date', wrapped: true }
    ]
    const tracker = new PromptTracker()
    tracker.noteKeystroke(fakeBuffer(rows, { cursorX: 'root@h:~# '.length, cursorY: 0 }))
    const snap = tracker.snapshot()
    // 换行到达：光标在折行的下一行（第 2 行）
    const command = captureSubmitted(fakeBuffer(rows, { cursorX: 0, cursorY: 2 }), snap)
    expect(command?.startsWith('for i in 1 2 3;')).toBe(true)
    expect(command?.endsWith('0 && date')).toBe(true)
  })

  /**
   * 第一个到达的换行不一定是命令行的回显（`stty -echo`、口令提问、服务器先吐别的东西）。
   * 此时快照里的提示符与读到的那一行对不上 —— 必须退回启发式，
   * 而不是按一个不相干的列号硬切出一段假命令塞进历史。
   */
  it('换行来自别处（内容对不上快照的提示符）时退回启发式，不硬切', () => {
    const tracker = new PromptTracker()
    tracker.noteKeystroke(fakeBuffer(['root@host:~# '], { cursorX: 13, cursorY: 0 }))
    const snap = tracker.snapshot()
    // 读到的是一行毫不相干的输出，且不含 $ / # / % → 如实不记
    const other = fakeBuffer(['Reading package lists...'], { cursorX: 0, cursorY: 1 })
    expect(captureSubmitted(other, snap)).toBeNull()
  })

  it('光标还在第一行（没有上一行可读）时不采集', () => {
    const snap = new PromptTracker().snapshot()
    expect(captureSubmitted(fakeBuffer(['root@h:~# ls'], { cursorX: 0, cursorY: 0 }), snap)).toBeNull()
  })

  it('全屏程序（vim）里换行照旧不采集', () => {
    const tracker = new PromptTracker()
    const buf = fakeBuffer(['root@h:~# 看着像命令'], { cursorX: 0, cursorY: 1, type: 'alternate' })
    expect(captureSubmitted(buf, tracker.snapshot())).toBeNull()
  })
})

describe('提示符列不许跨行泄漏（行号被 xterm 环形复用 / clear 归零）', () => {
  /**
   * 把一行放在**指定的绝对行号**上。
   *
   * 与上面的 fakeBuffer 的区别只在这一点：fakeBuffer 按数组下标当行号（够用且直白），
   * 而这一组要构造的恰恰是"两个不同的提示符先后落在同一个绝对行号上"，
   * 所以行必须挂在 `baseY + cursorY` 那个位置上，而不是下标 0。
   * 真实几何：scrollback 5000 + 24 行 → 饱和后光标永远停在 5000 + 23 = 5023。
   */
  const SATURATED_ROW = 5023
  function bufAt(
    absRow: number,
    text: string,
    cursorX: number,
    cursorY = 23
  ): BufferLike {
    return {
      type: 'normal',
      baseY: absRow - cursorY,
      cursorX,
      cursorY,
      getLine: (y) =>
        y === absRow
          ? {
              isWrapped: false,
              translateToString: (trimRight?: boolean) =>
                trimRight ? text.replace(/\s+$/, '') : text.padEnd(COLS, ' ')
            }
          : undefined
    }
  }

  it('同一绝对行号上换了个更长的提示符 → 重新测量，切出的是命令而不是残片', () => {
    const tracker = new PromptTracker()
    // 第一条：~ 下执行 cd /tmp（提示符 13 列）
    tracker.noteKeystroke(bufAt(SATURATED_ROW, 'root@host:~# cd /tmp', 13))
    expect(submitAndCapture(tracker, bufAt(SATURATED_ROW, 'root@host:~# cd /tmp', 20))).toBe('cd /tmp')

    // 第二条：cd 之后提示符变长（16 列），但缓冲已饱和 → 绝对行号与上面**完全相同**
    const second = 'root@host:/tmp# cd /var/log'
    tracker.noteKeystroke(bufAt(SATURATED_ROW, second, 16))
    const command = submitAndCapture(tracker, bufAt(SATURATED_ROW, second, 27))
    expect(command).toBe('cd /var/log')
    // 缺陷版本用冻结的第 13 列去切 16 列的提示符 → 'p# cd /var/log'
    expect(command).not.toContain('#')
  })

  it('提示符没有 $ / # / % 时更致命：残片连启发式都救不回来', () => {
    const tracker = new PromptTracker()
    tracker.noteKeystroke(bufAt(SATURATED_ROW, '~ ❯ cd /tmp', 4))
    expect(submitAndCapture(tracker, bufAt(SATURATED_ROW, '~ ❯ cd /tmp', 11))).toBe('cd /tmp')

    const second = '/tmp ❯ cd /var/log'
    tracker.noteKeystroke(bufAt(SATURATED_ROW, second, 7))
    expect(submitAndCapture(tracker, bufAt(SATURATED_ROW, second, 18))).toBe('cd /var/log')
  })

  it('提示符变短（cd 回上层）也照样重新测量', () => {
    const tracker = new PromptTracker()
    tracker.noteKeystroke(bufAt(SATURATED_ROW, 'root@host:/var/log# cd /', 20))
    expect(submitAndCapture(tracker, bufAt(SATURATED_ROW, 'root@host:/var/log# cd /', 24))).toBe('cd /')

    const shallow = 'root@host:/# ls -al'
    tracker.noteKeystroke(bufAt(SATURATED_ROW, shallow, 12))
    expect(submitAndCapture(tracker, bufAt(SATURATED_ROW, shallow, 19))).toBe('ls -al')
  })

  it('clear() 把行号归零 → 两次 clear 之间 cd 过，第二条照样不许沿用旧列', () => {
    /*
     * 这一条不需要 scrollback 饱和：`clear()`（消除按钮 / shell 的 clear，ESC[3J）
     * 把 ybase 与 y 都归零，于是**每次 clear 之后的提示符都落在绝对行 0**。
     * 两次 clear 之间 cd 过一次，就凑出"同一行号、两个不同提示符"。
     */
    const tracker = new PromptTracker()
    // 第一次 clear 之后：在 ~ 下敲一条
    tracker.noteKeystroke(bufAt(0, 'root@host:~# ls', 13, 0))
    expect(submitAndCapture(tracker, bufAt(0, 'root@host:~# ls', 15, 0))).toBe('ls')
    // cd 过、又 clear 了一次 → 还是绝对行 0，但提示符更长
    const after = 'root@host:/etc/nginx# nginx -t'
    tracker.noteKeystroke(bufAt(0, after, 22, 0))
    const command = submitAndCapture(tracker, bufAt(0, after, 30, 0))
    expect(command).toBe('nginx -t')
    expect(command).not.toContain('#')
  })

  it('提示符没变（同一 cwd 连着敲）时仍然只测第一次', () => {
    const tracker = new PromptTracker()
    const rows = 'root@host:~# ls -al'
    tracker.noteKeystroke(bufAt(SATURATED_ROW, rows, 13))
    // 打字过程中的后续按键不许把列号推走
    tracker.noteKeystroke(bufAt(SATURATED_ROW, rows, 16))
    expect(tracker.promptColFor(bufAt(SATURATED_ROW, rows, 19))).toBe(13)
  })

  it('回车即失效：提交过的那一列不许被下一行沿用', () => {
    const tracker = new PromptTracker()
    const rows = 'root@host:~# pwd'
    tracker.noteKeystroke(bufAt(SATURATED_ROW, rows, 13))
    expect(submitAndCapture(tracker, bufAt(SATURATED_ROW, rows, 16))).toBe('pwd')
    // 采集完就该忘掉 —— 哪怕下一行落在同一个绝对行号上
    expect(tracker.promptColFor(bufAt(SATURATED_ROW, rows, 16))).toBeNull()
  })

  it('快捷命令回填的不可信闩只在那一行有效，行被复用后能恢复可信', () => {
    const tracker = new PromptTracker()
    // 约定是"写之前调"，那时这一行还只是提示符
    tracker.noteProgrammaticWrite(bufAt(SATURATED_ROW, 'root@host:~# ', 13))
    const filled = 'root@host:~# df -h'
    // 同一行：闩闩着 → 主路让位，退回启发式拿整条命令
    expect(tracker.promptColFor(bufAt(SATURATED_ROW, filled, 18))).toBeNull()
    expect(submitAndCapture(tracker, bufAt(SATURATED_ROW, filled, 18))).toBe('df -h')
    // 复用出的新提示符（cd 过，更长）：重新测量、恢复可信，主路照样切得对
    const next = 'root@host:/opt# systemctl status nginx'
    tracker.noteKeystroke(bufAt(SATURATED_ROW, next, 16))
    expect(tracker.promptColFor(bufAt(SATURATED_ROW, next, 38))).toBe(16)
  })
})
