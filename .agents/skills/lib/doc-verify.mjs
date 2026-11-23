/**
 * doc-verify.mjs —— 把文档里的机械断言真跑一遍，产出「已核事实表」。
 *
 * ## 为什么这是根本解法，而不是加速技巧
 *
 * 审核慢的根因不是审核人笨或工具慢，而是**分工错了**：
 *
 * - 「这个文件在不在」「这个函数/字段在代码里有没有」「这条命令跑得通吗」——
 *   这些**不需要判断**，机器一秒能核完；
 * - 「这条判据能不能证伪」「这个取舍对不对」——这些**只有人能判**。
 *
 * 手工核对方式会把两件事混在一起：审核人每次都要人工逐条核几十条事实，
 * 十几分钟全花在机器该干的活上，真正需要判断的那几条反而没时间细看。
 *
 * 这里把前一半接过来。审核人拿到的是：
 *
 * > 这份文档里有 47 条机械断言，我核过了：44 条成立，3 条不成立（列出来）。
 *
 * 于是他的时间只花在剩下那份「需要判断」的清单上。
 *
 * ## 判据要宽，不能窄
 *
 * 核「这个名字在代码里有没有」时，**不要求它是模块导出**：
 * 文档里大量引用的是对象的键（`missingModulesInTdd`、`handWritten`）与函数内部的名字，
 * 它们根本不是 export。窄成「必须在 export 里」会造出一堆假红灯，
 * 比不核还糟——审核人会开始不信这张表。
 *
 * 所以判据是：**这个名字在源码里出现过吗**（词边界）。
 * 它不证明「用法正确」，只证明「不是编的」——而后者正是审核人手工核的那件事。
 */

import { EXIT } from './exit-codes.mjs'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { checkPathClaim, collectDocClaims } from './doc-facts.mjs'
import { evaluateReadonlyDocCommand } from './doc-facts-commands.mjs'
import { CODE_EXT_RE, COMMON_SKIP_DIRS } from './git-core.mjs'
import { parseDevProfile } from './profile.mjs'

const run = promisify(execFile)

/** 核名字时不扫的目录：复用单源 COMMON_SKIP_DIRS 叠加历史归档。 */
function isSkippedScanPath(rel) {
  if (rel.startsWith('docs/archive/')) return true
  const parts = String(rel ?? '').split('/')
  return parts.slice(0, -1).some((seg) => COMMON_SKIP_DIRS.has(seg))
}

/** 只扫这些扩展名——它们才可能「定义」一个名字。 */
const CODE_EXT = CODE_EXT_RE

/**
 * 收集仓库里所有源码文本。
 *
 * 走 `git ls-files` 而不是递归 `readdir`：它天然排除被忽略的东西，
 * 也天然只含「这个项目真正在意」的文件。
 *
 * @param {string} root
 * @returns {{ files: string[], text: string }}
 */
function readCodebase(root) {
  let files = []
  try {
    const out = execFileSync('git', ['ls-files'], {
      cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024,
    })
    files = out.split('\n').map((s) => s.trim()).filter(Boolean)
  } catch {
    files = []
  }
  const code = files.filter((f) => CODE_EXT.test(f) && !isSkippedScanPath(f))
  let text = ''
  for (const f of code) {
    try { text += readFileSync(join(root, f), 'utf8') } catch { /* 读不到就跳过 */ }
  }
  return { files: code, text }
}

/**
 * 核一个名字在源码里出现过没有。
 *
 * @param {string} codeText
 * @param {string} name
 * @returns {{ ok: boolean, why?: string }}
 */
function checkNameExists(codeText, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`)
  return re.test(codeText) ? { ok: true } : { ok: false, why: '源码里没有这个名字' }
}

/**
 * 核一条命令：真跑，看退出码。
 *
 * 只跑**只读命令**。文档里也可能写着会删东西的命令，那种一律不跑——
 * 核实一条断言不该有副作用。
 *
 * @param {string} root
 * @param {string} cmd
 * @returns {Promise<object>}
 */
async function checkCommandClaim(root, cmd, profile = null) {
  const policy = evaluateReadonlyDocCommand(cmd, profile)
  if (!policy.allowed) return { ok: true, ran: false, why: policy.why ?? '非只读命令，未执行' }

  const parts = cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  const args = parts.slice(1).map((a) => a.replace(/^["']|["']$/g, ''))
  try {
    const { stdout } = await run(parts[0], args, {
      cwd: root, timeout: 180000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    })
    return { ok: true, ran: true, exitCode: EXIT.OK, tail: String(stdout).slice(-300) }
  } catch (error) {
    return {
      ok: false,
      ran: true,
      exitCode: typeof error.code === 'number' ? error.code : -1,
      tail: String(error.stdout ?? error.message ?? '').slice(-300),
      why: '命令退出码非 0',
    }
  }
}

/**
 * 核一份文档里的全部机械断言。
 *
 * @param {string} root 仓库根
 * @param {string} text 文档全文
 * @returns {Promise<object>}
 */
export async function verifyDocClaims(root, text, { runCommands = true } = {}) {
  const claims = collectDocClaims(text)
  const { text: codeText, files: codeFiles } = readCodebase(root)

  const paths = claims.paths.map((rel) => ({ rel, ...checkPathClaim(root, rel) }))
  const names = claims.identifiers.map((name) => ({ name, ...checkNameExists(codeText, name) }))

  const profile = runCommands ? parseDevProfile(root) : null
  const commands = []
  for (const cmd of claims.commands) {
    if (!runCommands) {
      commands.push({ cmd, ok: true, ran: false, skippedByStaticMode: true, why: '静态核查模式，未执行命令（传 --run-commands 可真跑）' })
    } else {
      commands.push({ cmd, ...(await checkCommandClaim(root, cmd, profile)) })
    }
  }

  const failedPaths = paths.filter((r) => !r.ok)
  const failedNames = names.filter((r) => !r.ok)
  const failedCommands = commands.filter((r) => !r.ok && r.ran)

  const total = paths.length + names.length + commands.length
  const failed = failedPaths.length + failedNames.length + failedCommands.length

  return {
    total,
    failed,
    staticOnly: !runCommands,
    scannedFiles: codeFiles.length,
    paths,
    names,
    commands,
    summary: `核了 ${total} 条机械断言（扫了 ${codeFiles.length} 个源码文件${runCommands ? '' : '，命令仅静态识别未执行'}）：${total - failed} 条成立，${failed} 条不成立`,
  }
}

/**
 * 把核实结果写成一段给审核人看的说明。
 *
 * @param {object} result
 * @returns {string}
 */
export function renderVerificationForReviewer(result) {
  const lines = [
    '## 已替你核过的机械事实',
    '',
    '> 这一段由 `doc-plan verify-facts` 自动生成。',
    result.staticOnly
      ? '> 默认静态核查模式（不执行测试命令）：已核验仓内路径与符号；若需真跑文档只读命令请显式传 `--run-commands`。'
      : '> 文件在不在、名字在代码里有没有、命令跑不跑得通——这些不需要人判断，已经跑过一遍了。',
    '> **请把时间花在「这条判据能不能证伪」这类判断上**，别再手工核这些。',
    '',
    result.summary,
    '',
  ]

  // 命令跑不通是硬错：文档写着「跑这条」，而它跑不了，没有第二种解释。
  const badCommands = result.commands.filter((x) => !x.ok && x.ran)

  // 名字/路径找不到有两种可能（要新建的 / 写错了），工具分不出来，单列一类。
  const maybeNew = [
    ...result.paths.filter((x) => !x.ok).map((x) => ({ kind: '路径', what: x.rel })),
    ...result.names.filter((x) => !x.ok).map((x) => ({ kind: '名字', what: x.name })),
  ]

  if (badCommands.length === 0 && maybeNew.length === 0) {
    lines.push('**全部成立。** 事实层面没有可挑的。', '')
    return lines.join('\n')
  }

  if (badCommands.length > 0) {
    lines.push('### 命令跑不通（硬错，文档要改）', '')
    for (const r of badCommands) {
      lines.push(`- \`${r.cmd}\`（退出码 ${r.exitCode}）`)
      const last = String(r.tail ?? '').split('\n').filter(Boolean).slice(-1)[0]
      if (last) lines.push(`  - 输出尾部：\`${last.slice(0, 160)}\``)
    }
    lines.push('')
  }

  if (maybeNew.length > 0) {
    lines.push('### 源码里还没有（请确认是「要新建」还是「写错了」）', '')
    lines.push('> 工具分不出这两种。**这一小段是人要看的**——其余都核完了。', '')
    for (const r of maybeNew) lines.push(`- ${r.kind}：\`${r.what}\``)
    lines.push('')
  }

  return lines.join('\n')
}
