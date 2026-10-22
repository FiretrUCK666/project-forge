/**
 * ledger.mjs —— 「我在这里写过什么」的账本
 *
 * 存在理由只有一个：**痕迹判定不能靠猜。**
 *
 * 在此之前，判断「这段内容是不是本 skill 留下的」靠三样东西——标识符、模板指纹、
 * 落点路径。三样都是**从产物倒推来历**，而倒推必然出两种错：
 *
 *   - 误伤：`{{ title }}` 是 Vue 的正常语法，与「模板没填完」形状一样，于是被判成痕迹，
 *     照着处置就是删掉使用者自己的代码；
 *   - 漏判：`<安装命令>` 这种占位符没有进入形状判据，于是空壳工作流被报成「已经干净」。
 *
 * 这不是判据写得不够细，是**判据的形态错了**。本模块把「来历」变成**记录**：
 * 落盘那一刻写下「哪个文件的哪一段、字节哈希是多少」，此后只做比对，不做推断。
 *
 * 三态因此是闭合的，而且每一态对应一个确定的动作：
 *
 *   | 账本 | 文件现状 | 判定 | 动作 |
 *   | --- | --- | --- | --- |
 *   | 有   | 哈希对   | 确定是痕迹 | 可以撤（精确到字节），可以刷新 |
 *   | 有   | 哈希不对 | 使用者改过 | **问人**，不覆盖也不删 |
 *   | 有   | 找不到   | 使用者删了或挪了 | **问人**，不要重新插一遍 |
 *   | 无   | 形状像   | **不是痕迹** | 不动（不再误伤） |
 *
 * 账本放在目标项目的 `.project-forge/ledger.json`，**进版本库**：归属是项目事实，
 * 不是本机缓存——换机器、换会话、换 AI 都该读得到。
 *
 * **账本丢了怎么办**：退化成「什么都不认」。落盘只做加法（不会破坏），撤除一律跳过并
 * 问人（不会误删）。错在「少撤」而不是「多撤」，这是唯一安全的退化方向。
 *
 * **伪造账本有没有收益**：没有。正确性由内容哈希**当场重算**保证——伪造一条 `mine`
 * 记录，哈希对不上仍按「改过」处理，仍然拒绝动手。伪造成本高于收益，不需要额外防御。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 账本目录与文件名。放在项目根下，随仓库走。 */
export const LEDGER_DIR = '.project-forge'
export const LEDGER_FILE = 'ledger.json'

/** 账本格式版本。读取时版本不符就当作「没有账本」，退化成只做加法。 */
const LEDGER_SCHEMA = 1

/** 一个片段的完整校验哈希：短前缀足够区分「同一工具写的不同内容」。 */
export function hashOf(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 32)
}

/**
 * 把「我写下的那串字节」归一化后再算哈希。
 *
 * 归一化只处理**与内容无关的差异**：行尾。同一个工具在 CRLF 与 LF 检出上写出来的东西
 * 是同一段，若按原始字节算哈希，一次换行符归一化就会让所有记录失效——那种失效没有
 * 任何提示，只会表现为「什么都不认了」。
 */
export function contentHash(text) {
  return hashOf(String(text ?? '').replace(/\r\n/g, '\n'))
}

/** 账本在项目里的绝对路径。 */
export function ledgerPath(root) {
  return join(root, LEDGER_DIR, LEDGER_FILE)
}

/** 空账本。 */
function emptyLedger() {
  return { schema: LEDGER_SCHEMA, skill: 'project-forge', segments: {} }
}

/**
 * 读账本。**读不到就返回空账本，不抛错**——账本缺失是正常状态（老项目、被清理过），
 * 而「没有账本」的正确行为是「什么都不敢认」，不是停下来。
 */
export function readLedger(root) {
  const p = ledgerPath(root)
  if (!existsSync(p)) return emptyLedger()
  let raw
  try {
    raw = readFileSync(p, 'utf8')
  } catch {
    return emptyLedger()
  }
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    // 账本坏了等同于没有：继续用一份空账本，既不覆盖也不删。
    return emptyLedger()
  }
  if (typeof data !== 'object' || data === null) return emptyLedger()
  if (data.schema !== LEDGER_SCHEMA) return emptyLedger()
  if (typeof data.segments !== 'object' || data.segments === null) return emptyLedger()
  return data
}

/** 原子写账本：先写同目录临时文件再改名，中途被杀不会留下半截 JSON。 */
export function writeLedger(root, ledger) {
  const p = ledgerPath(root)
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
  try {
    renameSync(tmp, p)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* 清不掉就留着，下次清理 */ }
    throw error
  }
}

/**
 * 记一条片段。`spec` 说明这一段是怎么落下去的：
 *
 *   - `anchor`：独占一个字节区间，用一对注释锚点圈定（内核区、CI 里的一个 job）；
 *     撤除时整段挖掉，锚点之外一个字节不动。
 *   - `section`：一个二级标题下的一节（AGENTS.md 的受管节）；
 *     撤除时删掉这一节——这是「我们加的节」的机器依据。
 *   - `whole`：整份文件由我们新建（LICENSE、新落盘的 workflow）；
 *     只有文件内容与我们记的完全一致时才敢删。
 *
 * 记录的是**实际写下去的那串字节**的哈希，不是「我打算写什么」——两者在模板求值出错
 * 时会不同，而那时唯一正确的行为是「下次不认它」。
 */
export function recordSegment(ledger, { file, id, landing, content, at }) {
  const fileKey = String(file).replace(/\\/g, '/')
  const segments = ledger.segments[fileKey] ?? (ledger.segments[fileKey] = {})
  segments[id] = {
    landing,
    mine: contentHash(content),
    at: at ?? new Date().toISOString(),
  }
  return ledger
}

/** 取一条片段记录，没有就返回 undefined。 */
export function getSegment(ledger, file, id) {
  const fileKey = String(file).replace(/\\/g, '/')
  return ledger.segments[fileKey]?.[id]
}

/** 某文件下的全部片段 id。 */
export function segmentIds(ledger, file) {
  const fileKey = String(file).replace(/\\/g, '/')
  return Object.keys(ledger.segments[fileKey] ?? {})
}

/**
 * 一个片段现在归谁——**这是整个机制的核心，只此一处实现**。
 *
 * 返回值是六态之一，不是布尔。压成「是/否」必然在某一侧出错：
 *
 *   | state | 含义 | 压成二值会怎样 |
 *   | --- | --- | --- |
 *   | `mine` | 我写的，没动过 | 正确 |
 *   | `edited` | 我写的，被动过 | 当成 mine → 覆盖使用者内容 |
 *   | `gone` | 我写过，现在不在 | 当成「没写过」→ 重新插一遍，使用者的删除被撤销 |
 *   | `foreign` | 从来不是我写的 | 当成 mine → 删掉使用者的内容 |
 *   | `absent` | 文件本身不存在 | — |
 *   | `broken` | 锚点只有一半 | 猜位置 → 插进代码块里 |
 *
 * `existing` 传文件当前全文；片段内容的提取由调用方给（不同 landing 的提取方式不同）。
 */
export function provenance(ledger, { file, id, existing, extract }) {
  const record = getSegment(ledger, file, id)
  if (existing === undefined || existing === null) {
    return { state: record === undefined ? 'absent' : 'gone', record }
  }
  if (record === undefined) return { state: 'foreign', record: undefined }
  const got = extract(existing)
  if (got === null) return { state: 'gone', record }
  if (got === false) return { state: 'broken', record }
  return { state: contentHash(got) === record.mine ? 'mine' : 'edited', record, body: got }
}

/** 某文件在账本里有没有任何记录。 */
export function hasAnyRecord(ledger, file) {
  return segmentIds(ledger, file).length > 0
}

/** 删掉一条记录（撤除之后调用）。 */
export function forgetSegment(ledger, file, id) {
  const fileKey = String(file).replace(/\\/g, '/')
  if (ledger.segments[fileKey]?.[id] !== undefined) {
    delete ledger.segments[fileKey][id]
    if (Object.keys(ledger.segments[fileKey]).length === 0) delete ledger.segments[fileKey]
  }
  return ledger
}
