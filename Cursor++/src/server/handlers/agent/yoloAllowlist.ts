/**
 * YOLO 命令白名单同步 — 从 Cursor 客户端状态库只读加载。
 *
 * 背景: Auto-review 模式下服务端 shell preflight 对每条命令都发一次分类器
 * (Haiku) 调用,即使命令已在用户于 Cursor 设置里配置的自动运行白名单中
 * (composerState.yoloCommandAllowlist) —— 该白名单只存在于客户端进程,
 * 服务端无法感知。本模块只读同步这份白名单,让 preflight 能对白名单内
 * 命令跳过分类器直接放行 (仍下发 skipApproval=true),命中不了照常分类。
 *
 * 数据源 (本机实测验证): state.vscdb → ItemTable → applicationUser 键
 * → composerState.{yoloCommandAllowlist, yoloCommandDenylist, smartAllowlistDenylist}。
 *
 * 安全边界: 所有读取失败 (文件不存在/库打不开/键缺失/JSON 损坏) 一律视为
 * 白名单为空,判定返回 unsure → 走原分类流程;匹配语义刻意保守 —— 复合命令
 * (含 && ; | > 等) 与含通配符的条目都不短路。偏差方向是"多分类几次",
 * 而不是"错误放行"。仅服务端 preflight (链路 A) 使用;客户端主动发来的
 * ClassifySandAutoReview (链路 B) 不接短路 —— 客户端发该请求即表示其本地
 * 白名单未命中,服务端不应越权改判。
 */
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadSqlite3 } from '../../database/sqlite'
import { logger } from '../../logger'

const APPLICATION_USER_KEY
  = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser'

/** mtime 重载防抖 — reactiveStorage 写回频繁,限制重查频率 */
const RELOAD_MIN_INTERVAL_MS = 30_000

/** 测试环境覆盖真实 state.vscdb 路径 */
const STATE_DB_PATH_ENV = 'CURSOR_STATE_DB_PATH'

export interface YoloAllowlists {
  allow: ReadonlySet<string>
  deny: ReadonlySet<string>
  smartDeny: ReadonlySet<string>
}

/** 三平台 Cursor 状态库路径 — 与 installer/src/release-defaults.js 的解析保持一致 */
export function getStateDbPath(): string {
  const envPath = process.env[STATE_DB_PATH_ENV]
  if (envPath)
    return envPath

  const home = homedir()
  switch (process.platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
    case 'win32':
      return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'state.vscdb')
    case 'linux':
      return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'Cursor', 'User', 'globalStorage', 'state.vscdb')
    default:
      return join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  }
}

/** 规范化: 小写 + trim + 连续空白折叠, 命令与条目同规则 */
function normalizeEntry(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, ' ')
}

/**
 * 从 composerState 解析三份白/黑名单。非字符串条目直接过滤,
 * 条目小写化存储 (Windows 命令不区分大小写, 客户端大概率同样归一)。
 */
export function parseYoloAllowlists(composerState: unknown): YoloAllowlists {
  const collect = (field: string): Set<string> => {
    const raw = (composerState as Record<string, unknown> | null)?.[field]
    if (!Array.isArray(raw))
      return new Set()
    return new Set(
      raw.filter((entry): entry is string => typeof entry === 'string')
        .map(normalizeEntry)
        .filter(entry => entry.length > 0),
    )
  }
  return {
    allow: collect('yoloCommandAllowlist'),
    deny: collect('yoloCommandDenylist'),
    smartDeny: collect('smartAllowlistDenylist'),
  }
}

/**
 * 含通配符/正则语义字符的条目无法用保守规则安全匹配, 跳过不参与判定。
 */
function hasPatternChars(entry: string): boolean {
  return /[*?[\]{}\\^~]/.test(entry)
}

/**
 * 单条匹配语义 (保守双规则, 与客户端行为对齐的最小交集):
 *   - 条目无空格: 命令首 token 完全等于条目 (实测: 白名单含裸命令名 `python`,
 *     放行 `python -c "..."` 而不匹配 `python3 ...`)
 *   - 条目含空格: 命令以「条目 + 空格」为前缀 (如 `git commit` 放行 `git commit -m ...`)
 * 统一表达为 command === entry || command.startsWith(`${entry} `)。
 */
function matchesEntry(command: string, entry: string): boolean {
  return command === entry || command.startsWith(`${entry} `)
}

/**
 * 判定命令是否可由白名单短路放行。纯函数, lists 由调用方提供以便测试。
 *
 * 返回 'allow' 表示白名单明确命中; 其余情况一律 'unsure' (deny 命中、
 * 复合命令、匹配不上) → 调用方继续走分类器。
 */
export function checkYoloAllowlist(rawCommand: string, lists: YoloAllowlists): 'allow' | 'unsure' {
  if (lists.allow.size === 0)
    return 'unsure'

  // 复合命令 / 重定向 / 命令替换 / 后台执行 — 语义超出前缀匹配能力, 交给分类器。
  // 必须在归一化之前检测: normalizeEntry 会把换行折叠成空格, 检测就失效了
  if (/[;&|<>]|\$\(|`|\r|\n/.test(rawCommand))
    return 'unsure'

  const command = normalizeEntry(rawCommand)
  if (!command)
    return 'unsure'

  const hits = (set: ReadonlySet<string>): boolean => {
    for (const entry of set) {
      if (!hasPatternChars(entry) && matchesEntry(command, entry))
        return true
    }
    return false
  }

  if (hits(lists.deny) || hits(lists.smartDeny))
    return 'unsure'

  return hits(lists.allow) ? 'allow' : 'unsure'
}

// ── 模块级缓存 + mtime 惰性重载 ──────────────────────────────────

let cached: YoloAllowlists | null = null
let cachedMtimeMs = 0
let lastAttemptAt = 0

/** 只读打开 state.vscdb 查询 applicationUser 键 (node-sqlite3 回调 API) */
function queryApplicationUser(dbPath: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const sqlite3 = loadSqlite3()
    const rawDb = new (sqlite3 as any).Database(dbPath, (sqlite3 as any).OPEN_READONLY, (openErr: Error | null) => {
      if (openErr) {
        reject(openErr)
        return
      }
      rawDb.get('SELECT value FROM ItemTable WHERE key = ?', APPLICATION_USER_KEY, (getErr: Error | null, row: { value?: string } | undefined) => {
        rawDb.close(() => {})
        if (getErr)
          reject(getErr)
        else
          resolve(row?.value)
      })
    })
  })
}

async function loadAllowlists(dbPath: string): Promise<YoloAllowlists | null> {
  const value = await queryApplicationUser(dbPath)
  if (!value)
    return null
  const parsed = JSON.parse(value) as { composerState?: unknown }
  if (!parsed?.composerState || typeof parsed.composerState !== 'object')
    return null
  return parseYoloAllowlists(parsed.composerState)
}

/**
 * 取当前白名单 (mtime 变化时惰性重载, 30s 防抖)。
 * 加载失败时保留旧缓存 (白名单是低频变更数据), 无旧缓存则返回 null。
 */
async function getAllowlists(): Promise<YoloAllowlists | null> {
  const dbPath = getStateDbPath()
  if (!existsSync(dbPath)) {
    cached = null
    return null
  }

  try {
    const mtimeMs = (await stat(dbPath)).mtimeMs
    if (cached && mtimeMs === cachedMtimeMs)
      return cached
    if (cached && Date.now() - lastAttemptAt < RELOAD_MIN_INTERVAL_MS)
      return cached

    lastAttemptAt = Date.now()
    const next = await loadAllowlists(dbPath)
    if (next) {
      if (!cached || next.allow.size !== cached.allow.size) {
        logger.info({ allow: next.allow.size, deny: next.deny.size, smartDeny: next.smartDeny.size }, '[YOLO] allowlist synced from state.vscdb')
      }
      cached = next
      cachedMtimeMs = mtimeMs
    }
    else if (!cached) {
      logger.warn({ dbPath }, '[YOLO] allowlist key missing or malformed in state.vscdb')
    }
  }
  catch (error) {
    logger.warn({ error: (error as Error).message }, '[YOLO] failed to read allowlist from state.vscdb')
  }
  return cached
}

/**
 * shell preflight 短路检查入口。返回 true 表示命令明确命中用户白名单,
 * 调用方应跳过分类器直接放行; 任何失败/不确定一律返回 false 走原流程。
 */
export async function checkYoloAllowlistShortCircuit(command: string): Promise<boolean> {
  try {
    const lists = await getAllowlists()
    if (!lists)
      return false
    return checkYoloAllowlist(command, lists) === 'allow'
  }
  catch {
    return false
  }
}
