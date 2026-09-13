import { describe, expect, it } from 'vitest'
import { checkYoloAllowlist, parseYoloAllowlists } from '../handlers/agent/yoloAllowlist'

/**
 * YOLO 白名单解析与判定回归测试。
 *
 * 数据源 (state.vscdb → composerState) 的读取层不在此测 (依赖真实
 * Cursor 状态库), 只测纯函数: JSON 解析容错 + 匹配语义。
 * 匹配语义刻意保守 — 偏差方向是"多分类", 而不是"错误放行"。
 */

function makeLists(allow: string[], deny: string[] = [], smartDeny: string[] = []) {
  return parseYoloAllowlists({
    yoloCommandAllowlist: allow,
    yoloCommandDenylist: deny,
    smartAllowlistDenylist: smartDeny,
  })
}

describe('parseYoloAllowlists', () => {
  it('归一化条目: 小写 + trim + 空白折叠', () => {
    const lists = makeLists(['  Git   Status ', 'PYTHON'])
    expect(lists.allow.has('git status')).toBe(true)
    expect(lists.allow.has('python')).toBe(true)
  })

  it('过滤非字符串条目与空条目', () => {
    const lists = parseYoloAllowlists({
      yoloCommandAllowlist: ['git', 42, null, '   ', { cmd: 'ls' }],
      yoloCommandDenylist: 'not-an-array',
      smartAllowlistDenylist: undefined,
    })
    expect(lists.allow.has('git')).toBe(true)
    expect(lists.allow.size).toBe(1)
    expect(lists.deny.size).toBe(0)
    expect(lists.smartDeny.size).toBe(0)
  })
})

describe('checkYoloAllowlist', () => {
  it('裸命令条目按首 token 匹配 (实测语义: python 放行 python -c "...")', () => {
    const lists = makeLists(['python', 'sqlite3'])
    expect(checkYoloAllowlist('python -c "print(1)"', lists)).toBe('allow')
    expect(checkYoloAllowlist('sqlite3 file.db "SELECT 1"', lists)).toBe('allow')
    expect(checkYoloAllowlist('python', lists)).toBe('allow')
  })

  it('不同命令不因前缀子串误匹配 (python 不放行 python3)', () => {
    const lists = makeLists(['python'])
    expect(checkYoloAllowlist('python3 -c "x"', lists)).toBe('unsure')
  })

  it('含空格条目按「条目 + 空格」前缀匹配', () => {
    const lists = makeLists(['git commit', 'pnpm test'])
    expect(checkYoloAllowlist('git commit -m "msg"', lists)).toBe('allow')
    expect(checkYoloAllowlist('pnpm test file.spec', lists)).toBe('allow')
    // 子命令名 (test:server) 不是 test 的延伸, 保守不匹配
    expect(checkYoloAllowlist('git push', lists)).toBe('unsure')
    expect(checkYoloAllowlist('pnpm test:server', lists)).toBe('unsure')
  })

  it('大小写与多余空白归一后匹配', () => {
    const lists = makeLists(['git status'])
    expect(checkYoloAllowlist('GIT   STATUS', lists)).toBe('allow')
  })

  it('denylist 优先于 allowlist', () => {
    const lists = makeLists(['git'], ['git push'])
    expect(checkYoloAllowlist('git push --force', lists)).toBe('unsure')
    expect(checkYoloAllowlist('git status', lists)).toBe('allow')
  })

  it('smartAllowlistDenylist 同样短路 allowlist', () => {
    const lists = makeLists(['python'], [], ['python -c'])
    expect(checkYoloAllowlist('python -c "x"', lists)).toBe('unsure')
  })

  it('复合命令 (&& ; | > < $( 反引号 换行 &) 一律不短路', () => {
    const lists = makeLists(['git', 'echo', 'python'])
    expect(checkYoloAllowlist('git status && rm -rf /', lists)).toBe('unsure')
    expect(checkYoloAllowlist('echo a; echo b', lists)).toBe('unsure')
    expect(checkYoloAllowlist('cat f | grep x', lists)).toBe('unsure')
    expect(checkYoloAllowlist('git log > out.txt', lists)).toBe('unsure')
    expect(checkYoloAllowlist('python a.py &', lists)).toBe('unsure')
    expect(checkYoloAllowlist('echo $(whoami)', lists)).toBe('unsure')
    expect(checkYoloAllowlist('echo `whoami`', lists)).toBe('unsure')
    expect(checkYoloAllowlist('git status\necho done', lists)).toBe('unsure')
  })

  it('含通配符语义字符的条目跳过不参与匹配', () => {
    const lists = makeLists(['git*', 'npm run ?'])
    expect(checkYoloAllowlist('git status', lists)).toBe('unsure')
    expect(checkYoloAllowlist('npm run build', lists)).toBe('unsure')
  })

  it('空白名单 (读取失败场景) 一律 unsure', () => {
    const empty = makeLists([])
    expect(checkYoloAllowlist('python -c "x"', empty)).toBe('unsure')
  })

  it('空命令 unsure', () => {
    const lists = makeLists(['git'])
    expect(checkYoloAllowlist('   ', lists)).toBe('unsure')
  })
})
