/**
 * fixtures-brownfield-onboarding.mjs —— 存量项目接入（Issue #239 C1–C5）正反双向行为断言。
 *
 * 覆盖：
 *   1. C1/C2/C4：0 标记手写 AGENTS.md -> survey 标 upgrade、review 指引 --upgrade、
 *      handWrittenCoverage 大小写不敏感英文标题匹配与 HANDWRITTEN_MIN_CHARS 单一阈值、
 *      有受管标记或齐备 Dev Profile+意图路由 保持 preserve；
 *   2. C3：自有技能在 AGENTS.md 中严格只出现一次（无重复注入）、>15KB 自定义超限错误显式提示
 *      --allow-custom-oversize 且加该参数无损成功；
 *   3. C5：needsHuman.count > 0 时 S2 停步门禁绝不提前放出 equip.mjs；needsHuman.count === 0
 *      时按绝对 <skillRoot>/scripts/ 路径先 backup.mjs create --label pre-forge 再 equip.mjs。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { HANDWRITTEN_MIN_CHARS, handWrittenCoverage } from '../lib/agents-sections.mjs'
import { toMarkdown } from '../lib/render.mjs'
import { computeS3NextStep } from '../lib/survey-questions.mjs'
import { reviewProject } from '../review.mjs'
import { gitInit, rmTree, runNode, SKILL_ROOT, survey, tmpProject } from './fixtures-helpers.mjs'

export function registerBrownfieldOnboardingCases(cases) {
  cases.push(['Brownfield C1/C2/C4：手写 AGENTS.md 标 upgrade、review 推 --upgrade、小写英文标题与共享阈值（正反双向）', async () => {
    const customRuleMarker = 'UNIQUE_BROWNFIELD_RULE_NEVER_LOSE_239'
    const foreignAgents = [
      '# acme-service',
      '',
      '## Project overview',
      'This service processes billing webhooks and reconciles ledger entries across accounts.',
      '',
      '## Running tests',
      'Run `npm test` before every commit and check linting locally.',
      '',
      '## Coding rules',
      `Follow strict module boundaries. ${customRuleMarker}.`,
      '',
    ].join('\n')

    const foreignDir = tmpProject({
      'package.json': JSON.stringify({ name: 'acme-service', version: '1.0.0', private: true, scripts: { test: 'node --test' } }),
      'README.md': '# acme-service\n\nBrownfield onboarding test service.\n',
      'LICENSE': 'MIT License\n',
      'src/index.mjs': 'export const ok = 1\n',
      'AGENTS.md': foreignAgents,
    })

    const completeHandDir = tmpProject({
      'package.json': JSON.stringify({ name: 'complete-hand', version: '1.0.0', private: true }),
      'README.md': '# complete-hand\n\nComplete handwritten AGENTS.md.\n',
      'AGENTS.md': [
        '# complete-hand',
        '',
        '## 意图路由',
        '| 意图 | Skill | 脚本 |',
        '| --- | --- | --- |',
        '',
        '## Dev Profile',
        '```yaml',
        'quick-test: none',
        'full-test: none',
        'smoke-verify: none',
        'merge-gate: none',
        'arch-rules: none',
        'high-risk: AGENTS.md',
        'do-not-edit: docs/archive/',
        '```',
        '',
      ].join('\n'),
    })

    const shortMissDir = tmpProject({
      'package.json': JSON.stringify({ name: 'short-miss', version: '1.0.0', private: true }),
      'README.md': '# short-miss\n',
      // 正文超过 HANDWRITTEN_MIN_CHARS (80) 但不足旧硬编码 400，且只缺「修改边界」
      'AGENTS.md': [
        '# short-miss',
        '',
        '## Project overview',
        'This repository hosts a compact command line parser for configuration files with deterministic validation.',
        '',
        '## Running tests',
        'Execute `npm test` locally after edits to confirm every parser fixture passes without regressions.',
        '',
      ].join('\n'),
    })

    try {
      gitInit(foreignDir, { branch: 'main', name: 'Dev', email: 'dev@acme.test' })
      gitInit(completeHandDir, { branch: 'main', name: 'Dev', email: 'dev@acme.test' })
      gitInit(shortMissDir, { branch: 'main', name: 'Dev', email: 'dev@acme.test' })

      // 1. C4: handWrittenCoverage 大小写不敏感匹配英文标题
      const cov = handWrittenCoverage(foreignAgents)
      if (!cov.ok || cov.missing.length > 0 || cov.chars < HANDWRITTEN_MIN_CHARS) {
        return `C4 handWrittenCoverage 未能大小写不敏感匹配英文标题：${JSON.stringify(cov)}`
      }
      const shortMissChk = await runNode('compose-agents.mjs', [shortMissDir, '--check'])
      if (shortMissChk.status === 0 || shortMissChk.stderr.includes('正文只有')) {
        return `C4 正文 >= HANDWRITTEN_MIN_CHARS(${HANDWRITTEN_MIN_CHARS}) 但缺类别时误报字数不足：${shortMissChk.stderr}`
      }
      const tinyCov = handWrittenCoverage('# tiny\n\nOverview test rules.\n')
      if (tinyCov.ok || tinyCov.chars >= HANDWRITTEN_MIN_CHARS) {
        return `C4 过短手写文本未拦截：${JSON.stringify(tinyCov)}`
      }

      // 2. C1: 0 标记且缺 Dev Profile/意图路由 的外来手写 AGENTS.md -> action='upgrade'
      const fForeign = await survey(foreignDir)
      const foreignPlan = fForeign.artifactPlan.find((a) => a.id === 'agents-contract')
      if (foreignPlan?.action !== 'upgrade' || !foreignPlan.detail.includes('--upgrade')) {
        return `C1 外来 0 标记 AGENTS.md 未标 upgrade 或缺 --upgrade 说明：${JSON.stringify(foreignPlan)}`
      }
      if ((fForeign.docs.agentsMarkers?.regions?.length ?? -1) !== 0) {
        return `C1 外来手写 AGENTS.md regions 应为空数组：${JSON.stringify(fForeign.docs.agentsMarkers)}`
      }

      // 3. C1 反面：已有 Dev Profile + 意图路由 的完整手写契约保持 preserve
      const fComplete = await survey(completeHandDir)
      const completePlan = fComplete.artifactPlan.find((a) => a.id === 'agents-contract')
      if (completePlan?.action !== 'preserve') {
        return `C1 同时具备 Dev Profile 与 意图路由 的契约应保持 preserve：${JSON.stringify(completePlan)}`
      }

      // 4. C2: 装配 kit 后 review 对 0 标记缺失 Dev Profile 必须推荐 --upgrade
      const eq = await runNode('equip.mjs', [foreignDir, '--no-backup'])
      if (eq.status !== 0) return `equip 失败：${eq.stderr}`
      const rev = await reviewProject(foreignDir)
      const dpFinding = rev.results.find((r) => r.id === 'agents.handwritten-missing-dev-profile')
      if (!dpFinding || dpFinding.level !== 'missing' || !dpFinding.title.includes('compose-agents.mjs . --upgrade')) {
        return `C2 review 未对 0 标记手写契约推荐 --upgrade：${JSON.stringify(dpFinding)}`
      }

      // 5. C1/C2 闭环：执行 --upgrade 无损保留全部原手写内容，且受管后 survey 转为 preserve（填完 fill 后）
      const up = await runNode('compose-agents.mjs', [foreignDir, '--upgrade', '--no-backup'])
      if (up.status !== 0) return `compose-agents --upgrade 失败：${up.stderr}`
      const upgraded = readFileSync(join(foreignDir, 'AGENTS.md'), 'utf8')
      if (!upgraded.includes(customRuleMarker) || !upgraded.includes('## Project overview')) {
        return 'compose-agents --upgrade 丢失原有手写正文'
      }
      const cleaned = upgraded
        .replace(/^<!-- project-forge: fill [^\n]*-->$/gm, '已填实。')
        .replace(/^((?:quick-test|full-test|smoke-verify|merge-gate|arch-rules|high-risk|do-not-edit):\s*)<[^>\n]+>/gm, '$1none')
      writeFileSync(join(foreignDir, 'AGENTS.md'), cleaned, 'utf8')
      const fManaged = await survey(foreignDir)
      const managedPlan = fManaged.artifactPlan.find((a) => a.id === 'agents-contract')
      if (managedPlan?.action !== 'preserve' || (fManaged.docs.agentsMarkers?.regions?.length ?? 0) === 0) {
        return `C1 受管后干净 AGENTS.md 应保持 preserve：${JSON.stringify({ managedPlan, markers: fManaged.docs.agentsMarkers })}`
      }
      return true
    } finally {
      rmTree(foreignDir)
      rmTree(completeHandDir)
      rmTree(shortMissDir)
    }
  }])

  cases.push(['Brownfield C3：自有技能单源无重复注入与 >15KB 自定义超限提示 --allow-custom-oversize（正反双向）', async () => {
    const skillDir = tmpProject({
      'package.json': JSON.stringify({ name: 'c3-dedup', version: '1.0.0', private: true, scripts: { test: 'node --test' } }),
      'README.md': '# c3-dedup\n\nCustom skill single-source rendering test.\n',
      'src/app.mjs': 'export const run = () => true\n',
      '.claude/skills/my-sop/SKILL.md': [
        '---',
        'name: my-sop',
        'description: Run internal deployment SOP checks before releasing changes.',
        '---',
        '# my-sop',
      ].join('\n'),
      '.agents/skills/team-helper/SKILL.md': [
        '---',
        'name: team-helper',
        'description: Validate team domain schemas and fixtures.',
        '---',
        '# team-helper',
      ].join('\n'),
    })

    const hugeCustomMarker = 'PRESERVED_HUGE_CUSTOM_SECTION_239'
    const hugeHandAgents = [
      '# huge-brownfield',
      '',
      '## Project overview',
      `Legacy monorepo handbook. ${hugeCustomMarker}.`,
      '',
      '## Custom Domain Rules',
      'Rule line for legacy module boundary and compatibility guarantees.\n'.repeat(320),
    ].join('\n')

    const oversizeDir = tmpProject({
      'package.json': JSON.stringify({ name: 'c3-oversize', version: '1.0.0', private: true }),
      'README.md': '# c3-oversize\n\nOversize brownfield AGENTS.md test.\n',
      'AGENTS.md': hugeHandAgents,
    })

    try {
      gitInit(skillDir, { branch: 'main', name: 'Dev', email: 'dev@acme-fixture.dev' })
      gitInit(oversizeDir, { branch: 'main', name: 'Dev', email: 'dev@acme-fixture.dev' })

      // 1. 自有技能在 AGENTS.md 中严格只出现一次（无重复注入）
      const eq = await runNode('equip.mjs', [skillDir, '--no-backup'])
      if (eq.status !== 0) return `equip 失败：${eq.stderr}`
      const gen = await runNode('compose-agents.mjs', [skillDir, '--no-backup'])
      if (gen.status !== 0) return `compose-agents 失败：${gen.stderr}`
      const agentsText = readFileSync(join(skillDir, 'AGENTS.md'), 'utf8')
      const sopHits = (agentsText.match(/\.claude\/skills\/my-sop\/SKILL\.md/g) ?? []).length
      const helperHits = (agentsText.match(/\.agents\/skills\/team-helper\/SKILL\.md/g) ?? []).length
      if (sopHits !== 1 || helperHits !== 1) {
        return `C3 自有技能出现重复或缺失注入（my-sop=${sopHits}, team-helper=${helperHits}）`
      }

      // 2. >15KB 自定义手写 AGENTS.md --upgrade 降级软提示退出 0、完整保留原有长文并输出 managed/custom 分解与指针模式提示
      const softUp = await runNode('compose-agents.mjs', [oversizeDir, '--upgrade', '--no-backup'])
      if (softUp.status !== 0) return `C3 自定义长文超 30KB 应降级 notice 退出 0：${softUp.stderr}`
      if (!softUp.stderr.includes('--allow-custom-oversize') || !softUp.stderr.includes('managed=') || !softUp.stderr.includes('custom=')) {
        return `C3 自定义超限软提示缺少 managed/custom 拆解或兼容提示：${softUp.stderr}`
      }
      const afterSoft = readFileSync(join(oversizeDir, 'AGENTS.md'), 'utf8')
      if (!afterSoft.includes(hugeCustomMarker) || !afterSoft.includes('<!-- project-forge: begin Dev Profile -->')) {
        return 'C3 --upgrade 未保留自定义长文或未追加 Dev Profile'
      }

      // 3. 兼容参数 --allow-custom-oversize 继续接受并成功退出 0
      writeFileSync(join(oversizeDir, 'AGENTS.md'), hugeHandAgents, 'utf8')
      const allowUp = await runNode('compose-agents.mjs', [oversizeDir, '--upgrade', '--allow-custom-oversize', '--no-backup'])
      if (allowUp.status !== 0) return `C3 --upgrade --allow-custom-oversize 失败：${allowUp.stderr}`
      const afterAllow = readFileSync(join(oversizeDir, 'AGENTS.md'), 'utf8')
      if (!afterAllow.includes(hugeCustomMarker) || !afterAllow.includes('<!-- project-forge: begin Dev Profile -->')) {
        return 'C3 --upgrade --allow-custom-oversize 未保留自定义长文或未追加 Dev Profile'
      }

      // 4. SKILL.md 核心脚本注释显式提及 --allow-custom-oversize
      const skillMd = readFileSync(join(SKILL_ROOT, 'SKILL.md'), 'utf8')
      if (!skillMd.includes('--allow-custom-oversize')) {
        return 'C3 SKILL.md compose-agents 命令说明缺少 --allow-custom-oversize'
      }
      return true
    } finally {
      rmTree(skillDir)
      rmTree(oversizeDir)
    }
  }])

  cases.push(['Brownfield C5：survey needsHuman>0 停步门禁禁提前输出 equip.mjs，清零后绝对路径先 backup 再 equip（正反双向）', async () => {
    const askDir = tmpProject({
      'package.json': JSON.stringify({ name: 'c5-ask', version: '1.0.0', private: true }),
      'README.md': '# c5-ask\n\nRepo with pending human decisions.\n',
      'src/index.mjs': 'export const x = 1\n',
    })
    const readyDir = tmpProject({
      'package.json': JSON.stringify({ name: 'c5-ready', version: '1.0.0', private: true }),
      'README.md': '# c5-ready\n\nRepo with all human decisions resolved.\n',
      'LICENSE': 'MIT License\n',
      'src/index.mjs': 'export const y = 2\n',
      'AGENTS.md': [
        '# c5-ready',
        '',
        '## 取舍',
        '',
        '```text',
        '- `remote-setup`: local-only',
        '- `no-ci`: 本地测试',
        '```',
        '',
      ].join('\n'),
    })

    try {
      gitInit(askDir, { branch: 'main', name: 'Dev', email: 'dev@acme-fixture.dev' })
      gitInit(readyDir, { branch: 'main', name: 'Dev', email: 'dev@acme-fixture.dev' })

      // 1. 正向：needsHuman.count > 0 时停在 S2，[NEXT STEP] 严禁出现 equip.mjs 或 backup.mjs
      const fAsk = await survey(askDir)
      if (!fAsk.needsHuman?.required || (fAsk.needsHuman.count ?? 0) === 0) {
        return `测试前置条件：c5-ask 应有待拍板问题，实际：${JSON.stringify(fAsk.needsHuman)}`
      }
      if (fAsk.nextStep?.stage !== 'S2' || fAsk.nextStep?.blockedByNeedsHuman !== true) {
        return `C5 needsHuman > 0 时 nextStep 未停在 S2：${JSON.stringify(fAsk.nextStep)}`
      }
      if (fAsk.nextStep.equipCommand !== undefined || /equip\.mjs|backup\.mjs/.test(fAsk.nextStep.text)) {
        return `C5 needsHuman > 0 时违规提前放出 equip/backup 命令：${JSON.stringify(fAsk.nextStep)}`
      }
      const mdAsk = toMarkdown(fAsk)
      const nextStepLine = mdAsk.split('\n').find((l) => l.startsWith('[NEXT STEP]')) ?? ''
      if (!nextStepLine || /equip\.mjs/.test(nextStepLine)) {
        return `C5 Markdown 报告 [NEXT STEP] 行在 needsHuman > 0 时提前输出 equip.mjs：${nextStepLine}`
      }

      // 2. 反向：needsHuman.count === 0 时解析绝对 <skillRoot>/scripts/ 路径，且先 backup.mjs 后 equip.mjs
      const fReady = await survey(readyDir)
      if (fReady.needsHuman?.count !== 0) {
        return `测试前置条件：c5-ready 应无待拍板问题，实际：${JSON.stringify(fReady.questions)}`
      }
      const expectedScriptsDir = join(SKILL_ROOT, 'scripts').replace(/\\/g, '/')
      const ns = fReady.nextStep
      if (ns?.stage !== 'S3' || ns?.blockedByNeedsHuman !== false) {
        return `C5 needsHuman === 0 时应进入 S3：${JSON.stringify(ns)}`
      }
      if (!ns.backupCommand?.includes(`${expectedScriptsDir}/backup.mjs`) || !ns.backupCommand?.includes('--label pre-forge')) {
        return `C5 backupCommand 缺少绝对 scripts 路径或 --label pre-forge：${JSON.stringify(ns)}`
      }
      if (!ns.equipCommand?.includes(`${expectedScriptsDir}/equip.mjs`)) {
        return `C5 equipCommand 缺少绝对 scripts 路径：${JSON.stringify(ns)}`
      }
      const backupIdx = ns.text.indexOf('backup.mjs')
      const equipIdx = ns.text.indexOf('equip.mjs')
      if (backupIdx < 0 || equipIdx < 0 || backupIdx >= equipIdx) {
        return `C5 [NEXT STEP] 中 backup.mjs 必须排在 equip.mjs 之前：${ns.text}`
      }

      // 3. 空目录无需 backup，直接走 --bootstrap-empty
      const emptyStep = computeS3NextStep({
        maturity: 'empty',
        scale: { totalFiles: 0 },
        git: { available: true, present: false, commits: 0, hooks: {} },
        target: { path: '/tmp/empty-demo' },
        needsHuman: { required: false, count: 0, kinds: [] },
      })
      if (emptyStep.backupCommand !== undefined || !emptyStep.equipCommand?.includes('--bootstrap-empty')) {
        return `C5 空目录不应生成 backupCommand 且应带 --bootstrap-empty：${JSON.stringify(emptyStep)}`
      }
      return true
    } finally {
      rmTree(askDir)
      rmTree(readyDir)
    }
  }])

  cases.push(['Slice1 C3/C5/C6/C7：核心节防误跳 + skippedByHeading、ignoredButTracked 降级、claims 双态/拆词、裸取舍开关、命令校验与提交提示稳定', async () => {
    const { validateDevProfileRegion } = await import('../lib/agents-sections.mjs')
    const { verifyClaims, claimsOf } = await import('../lib/claims.mjs')
    const { readDecisionMap, parseAgentsProfile } = await import('../../kit/skills/lib/profile.mjs')
    const { sanitizeVerificationTool } = await import('../../kit/skills/lib/feature-map.mjs')
    const { validateExecutableCommandShape } = await import('../../kit/skills/lib/command-lex.mjs')
    const { commitStyleHint } = await import('../lib/agents-defaults.mjs')

    const bizPrefix = [
      '# BizApp Handbook',
      '',
      '## Project Overview',
      'Real-time collaborative document platform with rich domain docs.',
      '',
      '## Real-time Collaboration',
      'Users edit documents together over CRDT websockets. Example placeholder: `path/to/doc.ts`, `foo/bar/sample.mjs`.',
      '',
      '## General Guidelines',
      'Keep UI responsive and accessible. Also see `src/legacy-old-file.ts` for historical notes.',
      '',
      '## Architectural Decisions',
      'Postgres + Redis architecture.',
      '',
      '```yaml',
      'files: src/a.mjs,src/b.mjs',
      '```',
      '',
    ].join('\n')
    const dir = tmpProject({
      'package.json': JSON.stringify({ name: 'biz-app', version: '1.0.0', private: true, scripts: { test: 'node -e "process.exit(0)"' } }),
      'README.md': '# biz-app\n\nReal-time collaborative app test fixture.\n',
      'LICENSE': 'MIT License\n',
      '.gitignore': 'ignored-legacy.log\n.worktrees/\n',
      'ignored-legacy.log': 'legacy tracked content\n',
      'src/a.mjs': 'export const a = 1\n',
      'src/b.mjs': 'export const b = 2\n',
      'AGENTS.md': bizPrefix,
    })
    gitInit(dir, { branch: 'main', name: 'Dev', email: 'dev@biz-fixture.dev' })
    // 强行将 ignored-legacy.log 加入索引模拟上游历史 ignoredButTracked
    const { gitCommitFast, gitSync } = await import('./fixtures-helpers.mjs')
    gitSync(dir, ['add', '-f', 'ignored-legacy.log'])
    gitCommitFast(dir, 'chore: legacy tracked ignored file')

    try {
      await runNode('equip.mjs', [dir, '--no-backup'])
      const up = await runNode('compose-agents.mjs', [dir, '--upgrade', '--no-backup'])
      if (up.status !== 0) return `C3 --upgrade 失败：${up.stderr}`
      const upgraded = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
      if (!upgraded.startsWith(bizPrefix.trimEnd())) {
        return 'C3 --upgrade 未字节级保留既有 AGENTS.md 原文前缀'
      }
      for (const coreId of ['意图路由', 'Dev Profile', '修改守则', '日常协作与风险分流', '取舍']) {
        if (!upgraded.includes(`<!-- project-forge: begin ${coreId} -->`)) {
          return `C3 核心受管节 ${coreId} 被业务标题误跳过未注入`
        }
      }
      if (!up.stderr.includes('skippedByHeading')) {
        return `C3 --upgrade 跳过 Project Overview 时未输出 skippedByHeading 诊断：${up.stderr}`
      }

      // 填实占位并在 ## 取舍 测试裸开关 + evergreen-docs 跨区回读
      const hydrated = upgraded
        .replace(/^<!-- project-forge: fill [^\n]*-->$/gm, '已填实。')
        .replace(/^((?:quick-test|full-test|smoke-verify|merge-gate|arch-rules|high-risk|do-not-edit):\s*)<[^>\n]+>/gm, '$1none')
        .replace('<!-- project-forge: end 取舍 -->', '- no-git-hooks\n- evergreen-docs: docs/GUIDE.md, README.md\n<!-- project-forge: end 取舍 -->')
      writeFileSync(join(dir, 'AGENTS.md'), hydrated, 'utf8')

      // C5: ignoredButTracked 降级为 notice 且不阻断；C6: 非受管正文旧路径降级 notice；C3: skippedByHeading 在 review 中报出
      const rev = await reviewProject(dir)
      const igFinding = rev.results.find((r) => r.id === 'git.ignored-tracked')
      if (!igFinding || igFinding.level !== 'notice' || igFinding.decision !== 'ignore-tracked-legacy') {
        return `C5 git.ignored-tracked 应为 notice 且带 decision ignore-tracked-legacy：${JSON.stringify(igFinding)}`
      }
      const pathFinding = rev.results.find((r) => r.id === 'claim.path')
      if (!pathFinding || pathFinding.level !== 'notice') {
        return `C6 已融合仓非受管正文疑似旧路径应降级为 notice：${JSON.stringify(pathFinding)}`
      }
      if (!rev.results.some((r) => r.id === 'agents.skipped-by-heading' && r.level === 'notice')) {
        return `C3 review 未输出 agents.skipped-by-heading 诊断：${JSON.stringify(rev.results.filter((r) => r.scope === 'agents'))}`
      }
      if (rev.missing.length > 0) {
        return `C3/C5/C6 已融合仓不应被历史 ignoredButTracked 或非受管正文旧路径阻断：${JSON.stringify(rev.missing)}`
      }

      // C6: claimsOf 按 /[\s,]+/ 拆词且过滤 path/to/* 与 foo/bar/*
      const cl = claimsOf(bizPrefix)
      if (!cl.paths.includes('src/a.mjs') || !cl.paths.includes('src/b.mjs')) {
        return `C6 claimsOf 未按逗号拆词识别 src/a.mjs,src/b.mjs：${JSON.stringify(cl.paths)}`
      }
      if (cl.paths.some((p) => p.startsWith('path/to/') || p.startsWith('foo/bar/'))) {
        return `C6 claimsOf 未过滤国际通用占位前缀：${JSON.stringify(cl.paths)}`
      }
      // C6 反向：无受管标记的纯 AGENTS.md 中缺失路径维持 missing
      const pureRes = verifyClaims('# Pure\n\nRun `src/nonexistent.mjs`.\n', {}, () => false)
      const purePath = pureRes.find((x) => x.id === 'claim.path')
      if (!purePath || purePath.ok || purePath.level !== 'missing') {
        return `C6 无受管标记纯契约缺失路径应维持 missing：${JSON.stringify(purePath)}`
      }
      // C6: 裸取舍开关与 evergreen-docs 跨区回读
      const dm = readDecisionMap(hydrated)
      if (dm.get('no-git-hooks') !== 'true') return `C6 readDecisionMap 未识别裸取舍开关：${JSON.stringify([...dm.entries()])}`
      const prof = parseAgentsProfile(dir)
      if (!prof.evergreenDocs.includes('docs/GUIDE.md')) {
        return `C6 parseAgentsProfile 未从 ## 取舍 兼容回读 evergreen-docs：${JSON.stringify(prof.evergreenDocs)}`
      }

      // C7: validateExecutableCommandShape 拦截中文自然语言，放行合法 CLI 与 none；接入 Dev Profile 与 feature-map
      if (validateExecutableCommandShape('运行测试并检查输出', { allowNone: true }).ok) return 'C7 误放行中文自然语言命令'
      if (!validateExecutableCommandShape('none', { allowNone: true }).ok) return 'C7 误拦截显式 none'
      if (!validateExecutableCommandShape('npm test && node --version', { allowNone: false }).ok) return 'C7 误拦截合法命令'
      const badDp = validateDevProfileRegion('<!-- project-forge: begin Dev Profile -->\n## Dev Profile\n```yaml\nquick-test: 请运行全部单元测试\nfull-test: npm test\nsmoke-verify: none\nmerge-gate: npm test\narch-rules: none\nhigh-risk: src/\ndo-not-edit: docs/archive/\n```\n<!-- project-forge: end Dev Profile -->\n')
      if (badDp.ok) return 'C7 validateDevProfileRegion 误放行中文自然语言命令'
      const badTool = sanitizeVerificationTool({ id: 't1', kind: 'cli', command: '请手动打开页面确认' })
      if (badTool.command !== null) return `C7 sanitizeVerificationTool 未清洗自然语言伪命令：${JSON.stringify(badTool)}`

      // C7: commitStyleHint 在 1 次与 6 次 plain 提交间保持文本稳定，compose-agents --check 均退出 0
      const h1 = commitStyleHint({ conventions: { commitStyle: 'plain' }, git: { commits: 1 } })
      const h6 = commitStyleHint({ conventions: { commitStyle: 'plain' }, git: { commits: 6 } })
      if (h1 !== h6) return `C7 commitStyleHint 在 commits=1 与 6 间发生跳变：${h1} !== ${h6}`
      const chkBefore = await runNode('compose-agents.mjs', [dir, '--check'])
      if (chkBefore.status !== 0) return `C7 少提交态 --check 失败：${chkBefore.stderr}`
      for (let i = 0; i < 6; i += 1) {
        writeFileSync(join(dir, 'src/a.mjs'), `export const a = ${i + 2}\n`, 'utf8')
        gitCommitFast(dir, `plain update ${i + 1}`)
      }
      const chkAfter = await runNode('compose-agents.mjs', [dir, '--check'])
      if (chkAfter.status !== 0) return `C7 跨越 5 次 plain 提交后 --check 自破：${chkAfter.stderr}`
      return true
    } finally {
      rmTree(dir)
    }
  }])
}
