/**
 * fixtures-r6d-contracts.mjs —— R6D 默认分支收口、CLI 契约对拍扩面、解绑复制强锁、
 * 外部调研松绑 + Repo-Path Grounding、A1/A2/A3 与冲突消解的正反双向回归夹具。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { auditDoc } from '../../kit/skills/dev-plan/scripts/doc-audit.mjs'
import { initDoc } from '../../kit/skills/dev-plan/scripts/doc-plan-ops.mjs'
import { runEditGate } from '../../kit/skills/dev-edit/scripts/edit-gate.mjs'
import { collectChangedFilesSet } from '../../kit/skills/dev-govern/scripts/govern-state.mjs'
import { resolveDefaultBaseRef } from '../../kit/skills/dev-review/scripts/review-context.mjs'
import { verifyDocClaims } from '../../kit/skills/lib/doc-verify.mjs'
import { resolveRepoRoots } from '../../kit/skills/lib/git.mjs'
import { createDefaultLedger, writeTaskLedger } from '../../kit/skills/lib/ledger.mjs'
import { AGENTS_MAX_BYTES, AGENTS_WARN_BYTES } from '../lib/protocol.mjs'
import {
  SKILL_ROOT, gitCommitFast, gitInit, gitSync, rmTree, tmpProject,
} from './fixtures-helpers.mjs'

function makeNonMainDefaultRepo(branchName = 'trunk') {
  const dir = tmpProject({
    '.gitignore': '.worktrees/\n',
    'AGENTS.md': [
      '# non-main-demo',
      '',
      '```yaml',
      'quick-test: exit 0',
      'full-test: exit 0',
      'smoke-verify: none',
      'merge-gate: exit 0',
      'high-risk: none',
      '```',
      '',
    ].join('\n'),
    'src/app.mjs': 'export const app = 1\n',
  })
  gitInit(dir, { branch: branchName, name: 'dev', email: 'dev@example.com' })
  return dir
}

export function registerR6dContractsCases(cases) {
  cases.push(['R6D-C13: 剩余 4 处非 main/master 默认分支（trunk/develop）调用收口（正反双向）', async () => {
    const trunkDir = makeNonMainDefaultRepo('trunk')
    const devDir = makeNonMainDefaultRepo('develop')
    try {
      // 1. doc-plan-ops initDoc：trunk 默认分支有提交时自动隔离建 worktree；非默认特性分支原地建档
      const trunkRoots = await resolveRepoRoots(trunkDir)
      const initOnTrunk = await initDoc({
        repoRoot: trunkDir,
        mainRoot: trunkRoots.mainRoot,
        gitDir: trunkRoots.gitDir,
        isGit: trunkRoots.isGit,
        kind: 'todo',
        slug: 'trunk-task',
        title: 'Trunk Task',
        owner: 'plan-r6d',
      })
      if (!initOnTrunk.worktreePath || !String(initOnTrunk.worktreePath).includes('.worktrees/impl-trunk-task')) {
        return `doc-plan-ops initDoc 在 trunk 默认分支未自动隔离进 worktree：${JSON.stringify(initOnTrunk)}`
      }

      gitSync(trunkDir, ['checkout', '-b', 'feat/custom-work'])
      const featRoots = await resolveRepoRoots(trunkDir)
      const initOnFeat = await initDoc({
        repoRoot: trunkDir,
        mainRoot: featRoots.mainRoot,
        gitDir: featRoots.gitDir,
        isGit: featRoots.isGit,
        kind: 'todo',
        slug: 'feat-task',
        title: 'Feat Task',
        owner: 'plan-r6d',
      })
      if (initOnFeat.worktreePath) {
        return `doc-plan-ops initDoc 在非默认特性分支不应自动建隔离 worktree：${JSON.stringify(initOnFeat)}`
      }

      // 2. review-context resolveDefaultBaseRef：仅有 trunk（无 main/master）时应解析为 trunk
      const baseRef = await resolveDefaultBaseRef(trunkDir, 'HEAD')
      if (baseRef !== 'trunk') {
        return `review-context resolveDefaultBaseRef 在 trunk-only 仓返回 ${baseRef}，预期 trunk`
      }

      // 3. edit-gate：在 trunk 默认分支上不误匹配任意 taskLedger，在 feat 分支能对比 trunk 计算变更
      writeFileSync(join(trunkDir, 'src/app.mjs'), 'export const app = 2\n', 'utf8')
      gitCommitFast(trunkDir, 'feat: update on feat branch', { updateOnly: true })
      const gateFeat = await runEditGate({ dir: trunkDir, mode: 'standalone', changed: true })
      if (!gateFeat.checkedFiles.includes('src/app.mjs')) {
        return `edit-gate 在 feat 分支未能基于 trunk 检出改动：${JSON.stringify(gateFeat.checkedFiles)}`
      }
      gitSync(trunkDir, ['checkout', 'trunk'])
      writeTaskLedger(trunkDir, createDefaultLedger({
        taskId: 'unrelated-task',
        slug: 'unrelated-task',
        branch: 'trunk',
        caseType: 3,
      }))
      const gateTrunk = await runEditGate({ dir: trunkDir, mode: 'standalone', changed: true })
      if (!gateTrunk.ok) {
        return `edit-gate 在 trunk 默认分支上误报阻塞：${JSON.stringify(gateTrunk.blockers)}`
      }

      // 4. govern-state collectChangedFilesSet：未传入 defaultBranch 时应在 develop-only 仓解析 develop
      gitSync(devDir, ['checkout', '-b', 'feat/dev-change'])
      writeFileSync(join(devDir, 'src/app.mjs'), 'export const app = 3\n', 'utf8')
      gitCommitFast(devDir, 'feat: update on dev branch', { updateOnly: true })
      const changedSet = await collectChangedFilesSet(devDir, true, null)
      if (!changedSet.has('src/app.mjs')) {
        return `govern-state collectChangedFilesSet 在 develop-only 仓漏检改动：${JSON.stringify([...changedSet])}`
      }
      gitSync(devDir, ['checkout', 'develop'])
      const cleanSet = await collectChangedFilesSet(devDir, true, null)
      if (cleanSet.size !== 0) {
        return `govern-state 在干净 develop 默认分支误报改动：${JSON.stringify([...cleanSet])}`
      }
      return true
    } finally {
      rmTree(trunkDir)
      rmTree(devDir)
    }
  }])

  cases.push(['R6D-C13: cli-parity 扫描 SKILL.md 与 printNextStep 拦截幽灵/缺参且不误伤外部 CLI（正反双向）', async () => {
    const cliParity = await import('./cli-parity.mjs')
    assert.equal(typeof cliParity.auditSkillDocsAndNextSteps, 'function', 'cli-parity.mjs 缺少 auditSkillDocsAndNextSteps 导出')

    const realRes = cliParity.auditSkillDocsAndNextSteps({ ROOT: SKILL_ROOT })
    if (!realRes.ok || realRes.failures.length > 0) {
      return `本仓 SKILL.md / printNextStep 契约对拍未通过：${realRes.failures.join('；')}`
    }

    const reviewSkill = readFileSync(join(SKILL_ROOT, 'kit/skills/dev-review/SKILL.md'), 'utf8')
    if (/check-empirical[^\n]*--target\b/.test(reviewSkill)) {
      return 'kit/skills/dev-review/SKILL.md 仍残留幽灵参数 --target'
    }
    const flowSkill = readFileSync(join(SKILL_ROOT, 'kit/skills/dev-flow/SKILL.md'), 'utf8')
    if (!/submit[^\n]*--agent\b/.test(flowSkill) || !/cleanup[^\n]*--preview-hash\b/.test(flowSkill)) {
      return 'kit/skills/dev-flow/SKILL.md 缺少 submit --agent 或 cleanup --preview-hash 必填参数声明'
    }
    const planSkill = readFileSync(join(SKILL_ROOT, 'kit/skills/dev-plan/SKILL.md'), 'utf8')
    if (!/init[^\n]*--(?:owner|agent)\b/.test(planSkill)) {
      return 'kit/skills/dev-plan/SKILL.md init 行缺少 --owner / --agent 参数声明'
    }

    for (const darkFlag of ['prd', 'spec', 'todo', 'visual-evidence']) {
      if (cliParity.DARK_BASELINE['流程入口']?.includes(darkFlag)) {
        return `flow.mjs printHelp() 仍未消除暗参数 --${darkFlag}`
      }
    }

    // 反面 1：注入幽灵参数必须拦截
    const ghostRes = cliParity.auditCommandSnippet(
      'node ".agents/skills/dev-review/scripts/review-pack.mjs" check-empirical --task demo --target src/a.mjs',
      { ROOT: SKILL_ROOT },
    )
    if (ghostRes.ok || !ghostRes.failures.some((f) => f.includes('--target'))) {
      return `幽灵参数 --target 未被拦截：${JSON.stringify(ghostRes)}`
    }

    // 反面 2：缺失必填参数必须拦截
    const missingRes = cliParity.auditCommandSnippet(
      'node ".agents/skills/dev-flow/scripts/flow.mjs" submit --task demo',
      { ROOT: SKILL_ROOT },
    )
    if (missingRes.ok || !missingRes.failures.some((f) => f.includes('--agent'))) {
      return `submit 缺失 --agent 未被拦截：${JSON.stringify(missingRes)}`
    }

    // 正面：外部工具（git/gh/pytest/mvn）带任意参数绝不误伤
    const externalSnippets = [
      'git commit --amend --no-edit',
      'gh pr create --body-file /tmp/body.md --base trunk',
      'pytest -q --tb=short --maxfail=1',
      'mvn test -Dtest=SmokeTest -DfailIfNoTests=false',
    ]
    for (const cmd of externalSnippets) {
      const extRes = cliParity.auditCommandSnippet(cmd, { ROOT: SKILL_ROOT })
      if (!extRes.ok) return `外部命令被误伤：${cmd} -> ${extRes.failures.join('；')}`
    }
    return true
  }])

  cases.push(['R6D-C14: preflight-contract-rules 解绑复制强锁（权威源判据 + 入口指针，无硬压字节死线）', async () => {
    const rules = await import('./preflight-contract-rules.mjs')
    assert.equal(typeof rules.evaluatePushTierContract, 'function', 'preflight-contract-rules.mjs 缺少 evaluatePushTierContract 导出')

    const collab = readFileSync(join(SKILL_ROOT, 'references/collaboration.md'), 'utf8')
    const skill = readFileSync(join(SKILL_ROOT, 'SKILL.md'), 'utf8')
    const agents = readFileSync(join(SKILL_ROOT, 'AGENTS.md'), 'utf8')
    const tpl = readFileSync(join(SKILL_ROOT, 'templates/agents-project.md'), 'utf8')

    // 正面：SKILL.md 仅保留标题指针与红线（不全文复制 4 条规则），配合权威源必须通过
    const pointerOnlySkill = [
      '# project-forge',
      '',
      '日常合入与收尾见 `references/collaboration.md`「八、谁能合」「九、合并：收尾七步」。',
    ].join('\n')
    const passRes = rules.evaluatePushTierContract({
      'references/collaboration.md': collab,
      'SKILL.md': pointerOnlySkill,
      'AGENTS.md': agents,
      'templates/agents-project.md': tpl,
    })
    if (!passRes.ok) {
      return `解绑复制强锁后，仅含指针的入口 SKILL.md 仍被误拦：${passRes.failures.join('；')}`
    }

    // 反面 1：权威源缺少核心规则必须拦截
    const brokenCollab = collab.replace(/能不能撤回/g, '是不是对外')
    const badAuth = rules.evaluatePushTierContract({
      'references/collaboration.md': brokenCollab,
      'SKILL.md': skill,
      'AGENTS.md': agents,
      'templates/agents-project.md': tpl,
    })
    if (badAuth.ok) return '权威源 references/collaboration.md 缺少分档判据时未拦截'

    // 反面 2：入口缺少指针或包含过时表述必须拦截
    const staleSkill = `${skill}\n日常终点是提交 + 推送。\n`
    const badPointer = rules.evaluatePushTierContract({
      'references/collaboration.md': collab,
      'SKILL.md': staleSkill,
      'AGENTS.md': agents,
      'templates/agents-project.md': tpl,
    })
    if (badPointer.ok) return '入口含过时「提交 + 推送」表述时未拦截'

    // 反僵化底线：AGENTS_MAX_BYTES / AGENTS_WARN_BYTES 保持 30KB / 24KB（禁止 12-15KB 硬压死线）
    if (AGENTS_MAX_BYTES !== 30 * 1024 || AGENTS_WARN_BYTES !== 24 * 1024) {
      return `AGENTS 体积上限被擅改：warn=${AGENTS_WARN_BYTES}, max=${AGENTS_MAX_BYTES}`
    }
    return true
  }])

  cases.push(['R6D-C15: A1/A2/A3、冲突消解、外部调研松绑 + Repo-Path Grounding 与弹性探索（正反双向）', async () => {
    const skill = readFileSync(join(SKILL_ROOT, 'SKILL.md'), 'utf8')
    const surveyRef = readFileSync(join(SKILL_ROOT, 'references/survey.md'), 'utf8')
    const docsSetRef = readFileSync(join(SKILL_ROOT, 'references/docs-set.md'), 'utf8')
    const collabRef = readFileSync(join(SKILL_ROOT, 'references/collaboration.md'), 'utf8')
    const planSkill = readFileSync(join(SKILL_ROOT, 'kit/skills/dev-plan/SKILL.md'), 'utf8')
    const exploreSkill = readFileSync(join(SKILL_ROOT, 'kit/skills/dev-explore/SKILL.md'), 'utf8')
    const iterateSkill = readFileSync(join(SKILL_ROOT, 'kit/skills/dev-iterate/SKILL.md'), 'utf8')
    const reviewSkill = readFileSync(join(SKILL_ROOT, 'kit/skills/dev-review/SKILL.md'), 'utf8')

    // A1: docs-set.md 不再声称非平凡 todo 强制 Critique
    if (/非平凡\s*`?todo`?\s*强制/.test(docsSetRef)) {
      return 'references/docs-set.md 仍残留「非平凡 todo 强制 Critique」，未对齐 A1'
    }
    // A2: dev-iterate/SKILL.md 同步 --no-escalate 与默认开启说明
    if (!iterateSkill.includes('--no-escalate')) {
      return 'kit/skills/dev-iterate/SKILL.md 未同步 A2 --no-escalate 参数'
    }
    // A3: 独立审查通过后允许独立审查者或调度者 merge
    if (!/审查者或调度者/.test(collabRef) || !/审查者或调度者/.test(reviewSkill)) {
      return 'references/collaboration.md 或 dev-review/SKILL.md 未同步 A3（允许独立审查者或调度者 merge）'
    }
    // 外部调研松绑：不得再有 S1/S2 或 dev-plan 一刀切禁令
    if (/严禁调用网页搜索\/抓取工具/.test(skill + surveyRef) || /严禁未经用户要求擅自调用外部/.test(planSkill)) {
      return 'SKILL.md / references/survey.md / dev-plan/SKILL.md 仍残留对 webfetch/websearch 的一刀切禁令'
    }
    // 弹性探索：dev-explore/SKILL.md 不得写死 1–3 处文件数阈值
    if (/只查\s*1[–-]3\s*处/.test(exploreSkill)) {
      return 'kit/skills/dev-explore/SKILL.md 仍硬编码「只查 1–3 处」阈值'
    }

    // Repo-Path Grounding 正反双向验证：合法外部调研 URL + 真实仓内路径放行；未验真仓内幻觉路径拦截
    const dir = tmpProject({
      'src/real.mjs': 'export const realFn = () => true\n',
      'docs/specs/261124-ext-ground-spec.md': [
        '---',
        'kind: spec',
        'title: 外部调研与仓内路径落盘测试',
        'status: draft',
        'created: 2026-11-24',
        'updated: 2026-11-24',
        'issue: null',
        'pr: null',
        'owner: plan-r6d',
        '---',
        '',
        '# 外部调研与仓内路径落盘测试',
        '',
        '## 一、背景与目标',
        '- 外部参考：https://nodejs.org/api/fs.html',
        '- 仓内真实路径：`src/real.mjs`（`realFn`）',
        '',
        '## 二、本期不做',
        '- 不改动外部 API。',
        '',
        '## 三、冻结的验收标准',
        '- [ ] C1: `src/real.mjs` 导出 `realFn` 正常运行。',
        '',
      ].join('\n'),
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@example.com' })
    try {
      const goodAudit = auditDoc({ repoRoot: dir, file: 'docs/specs/261124-ext-ground-spec.md' })
      const pathErrs = goodAudit.errors.filter((e) => e.code === 'HALLUCINATED_PATH')
      if (pathErrs.length > 0) {
        return `合法外部 URL + 真实仓内路径被误报幻觉路径：${JSON.stringify(pathErrs)}`
      }
      const goodVerify = await verifyDocClaims(dir, readFileSync(join(dir, 'docs/specs/261124-ext-ground-spec.md'), 'utf8'), { runCommands: false })
      if (goodVerify.failed !== 0) {
        return `合法外部调研 + 真实仓内符号 verifyDocClaims 失败：${JSON.stringify(goodVerify)}`
      }

      // 反面：夹带未验真仓内路径必须拦截
      const badPath = join(dir, 'docs/specs/261124-ext-ground-bad-spec.md')
      writeFileSync(badPath, [
        '---',
        'kind: spec',
        'title: 外部调研夹带未验真仓内路径',
        'status: draft',
        'created: 2026-11-24',
        'updated: 2026-11-24',
        'issue: null',
        'pr: null',
        'owner: plan-r6d',
        '---',
        '',
        '# 外部调研夹带未验真仓内路径',
        '',
        '## 一、背景与目标',
        '- 外部参考：https://nodejs.org/api/fs.html',
        '- 未验真路径：`src/phantom-unverified.mjs`',
        '',
        '## 二、本期不做',
        '- 无。',
        '',
        '## 三、冻结的验收标准',
        '- [ ] C1: `src/phantom-unverified.mjs` 返回正常。',
        '',
      ].join('\n'), 'utf8')
      const badAudit = auditDoc({ repoRoot: dir, file: 'docs/specs/261124-ext-ground-bad-spec.md' })
      if (!badAudit.errors.some((e) => e.code === 'HALLUCINATED_PATH')) {
        return '外部调研文档夹带未验真仓内路径时未被 HALLUCINATED_PATH 拦截'
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])
}
