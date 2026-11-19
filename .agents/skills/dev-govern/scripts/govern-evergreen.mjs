/**
 * govern-evergreen.mjs —— 基于 `kit/skills/lib/profile.mjs` 单源 `discoverEvergreenDocs`
 * 对仓库全部常青权威文档统一执行失效源码路径、履历体与多副本分裂（`docs.duplicate-authority`）检测。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块与 kit/skills/lib/）。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { findChangelogVoice } from '../../lib/no-changelog-voice.mjs'
import { discoverEvergreenDocs } from '../../lib/profile.mjs'
import { addFinding, readTextStrictInfo } from './govern-checks.mjs'

const REPO_PATH_EXT_RE = /\.(?:mjs|cjs|js|ts|tsx|jsx|py|sh|ps1|rs|go|java|kt|cs|json|ya?ml|toml|lock|txt|cfg|ini|md)$/i

function extractDocBacktickPaths(rawTok) {
  const tok = String(rawTok ?? '').trim()
  if (!tok || /^(?:https?:|mailto:|git@|ssh:|\/|[A-Za-z]:|<)/.test(tok)) return []
  const words = /[\s;|&]/.test(tok) ? tok.split(/[\s,;()'"`]+/) : [tok]
  const out = []
  for (const word of words) {
    const clean = word.trim().replace(/^\.\//, '')
    if (!clean || !clean.includes('/') || clean.endsWith('/')) continue
    if (clean.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(clean)) continue
    if (/^(?:https?:|mailto:|git@|ssh:|\/|[A-Za-z]:|<)/.test(clean)) continue
    if (/[<>*?{}$]/.test(clean) || clean.includes('..')) continue
    if (!REPO_PATH_EXT_RE.test(clean)) continue
    out.push(clean)
  }
  return out
}

/** 转发单一真相源 `discoverEvergreenDocs`，供 `govern-audit.mjs` 等消费。 */
export function discoverEvergreenAuthorityDocs(repoRoot, files = [], agentsText = '', authoritativeTddPath = null) {
  return discoverEvergreenDocs(repoRoot, { files, agentsText, authoritativeTddPath })
}

/** 统一检查全部常青权威文档的失效路径、履历体写法及未指向的多副本分裂（`docs.duplicate-authority`）。 */
export function checkEvergreenAuthorityDocs(repoRoot, files, agentsText, authoritativeTddPath, findings) {
  const discovered = discoverEvergreenDocs(repoRoot, { files, agentsText, authoritativeTddPath })
  for (const doc of discovered.markdownDocs) {
    const info = readTextStrictInfo(join(repoRoot, doc.path))
    if (!info?.text) continue
    if (doc.path !== authoritativeTddPath) {
      const checked = new Set()
      for (const m of info.text.matchAll(/`([^`\n]+)`/g)) {
        for (const cand of extractDocBacktickPaths(m[1])) {
          if (checked.has(cand)) continue
          checked.add(cand)
          if (!existsSync(join(repoRoot, cand))) {
            addFinding(findings, {
              id: `docs.authority-stale-path.${doc.path}.${cand}`,
              category: 'docs',
              severity: 'medium',
              file: doc.path,
              title: `Stale source path referenced in evergreen authority doc ${doc.path}: ${cand}`,
              action: `Update or remove "${cand}" in ${doc.path} to keep single-source docs accurate.`,
            })
          }
        }
      }
    }
    const voiceHits = findChangelogVoice(info.text, { file: doc.path })
    if (voiceHits.length > 0) {
      const first = voiceHits[0]
      addFinding(findings, {
        id: `docs.authority-changelog-voice.${doc.path}`,
        category: 'docs',
        severity: 'low',
        file: doc.path,
        line: first.line,
        title: `Changelog/tombstone phrasing in evergreen doc ${doc.path}:${first.line} ("${first.word}")`,
        action: `Rewrite ${doc.path} to describe current behavior only; leave history in git commits.`,
      })
    }
  }

  for (const grp of discovered.duplicateGroups) {
    addFinding(findings, {
      id: `docs.duplicate-authority.${grp.stem}`,
      category: 'docs',
      severity: 'medium',
      file: grp.paths[0],
      title: `Duplicate unlinked evergreen authority docs for "${grp.stem}": ${grp.paths.join(', ')}`,
      action: `Converge ${grp.paths.join(' and ')} into a single canonical authority doc and point all entry docs to it.`,
    })
  }
  return discovered
}
