/**
 * fixtures-living-brief.mjs —— Living Visual Brief（C9–C10）正反双向行为与安全边界断言。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Script } from 'node:vm'

import { renderArchitectureMapFromRepo } from '../../kit/skills/lib/architecture-map.mjs'

import { EXIT } from '../../kit/skills/lib/exit-codes.mjs'
import { gitRun } from '../../kit/skills/lib/git.mjs'
import { readTaskLedger } from '../../kit/skills/lib/ledger.mjs'
import { buildPlanHandoff, evaluatePlanNextState } from '../../kit/skills/lib/plan-next.mjs'
import {
  projectVisualBriefViewModel,
  pruneStaleBriefs,
  readBriefSidecar,
  resolveBriefPaths,
  resolveBriefsDir,
  upsertVisualBrief,
} from '../../kit/skills/lib/visual-brief.mjs'
import { clarifyDoc, initDoc, sliceSpec } from '../../kit/skills/dev-plan/scripts/doc-plan-ops.mjs'
import { gitCommitFast, gitInit, rmTree, runAbsAsync, tmpProject } from './fixtures-helpers.mjs'

const DOC_PLAN = 'kit/skills/dev-plan/scripts/doc-plan.mjs'
const DOC_LOCATE = 'kit/skills/dev-explore/scripts/doc-locate.mjs'
const REPO_MAP = 'kit/skills/dev-explore/scripts/repo-map.mjs'
const FLOW = 'kit/skills/dev-flow/scripts/flow.mjs'

function makeRepoWithFeatureMap(name = 'lb-demo') {
  const dir = tmpProject({
    'package.json': JSON.stringify({ name, version: '1.0.0' }, null, 2) + '\n',
    'src/auth.mjs': 'export function login(u) { return Boolean(u) }\n',
    'src/export.mjs': 'export function exportCsv(rows) { return rows.join(",") }\n',
    'docs/feature-map.json': JSON.stringify({
      version: 2,
      domains: [{ id: 'core', name: 'Core Domain', entrypoints: ['src/auth.mjs'] }],
      features: [
        { id: 'auth', name: 'Auth', domain: 'core', entrypoints: ['src/auth.mjs'], modules: ['src/auth.mjs'], tests: [], dependsOn: [] },
        { id: 'export', name: 'Export', domain: 'core', entrypoints: ['src/export.mjs'], modules: ['src/export.mjs'], tests: [], dependsOn: ['auth'] },
      ],
      flows: [{ id: 'auth-export', name: 'Auth to Export', actors: ['user'], features: ['auth', 'export'], steps: [{ feature: 'auth', actor: 'user', action: 'sign in' }, { feature: 'export', actor: 'user', action: 'download' }] }],
    }, null, 2) + '\n',
  })
  gitInit(dir)
  gitCommitFast(dir, 'chore: init')
  return dir
}

export function registerLivingBriefCases(cases) {
  cases.push(['Living Brief C9/C10：Case 1/2 零触发、Case 3/4 与多轮 note 仓外生成、工作区零污染', async () => {
    const dir = makeRepoWithFeatureMap('lb-triage')
    try {
      const c1 = await runAbsAsync(DOC_PLAN, ['triage', '--summary', 'fix typo in comment', '--doc-only', '--json'], { cwd: dir })
      if (c1.status !== 0) return `Case 1 triage 失败：${c1.stderr}`
      const j1 = JSON.parse(c1.stdout)
      if (j1.visualBrief) return 'Case 1 不应生成 visualBrief'
      if (existsSync(resolveBriefsDir(dir))) return 'Case 1 不应创建仓外 briefs 目录'

      const c2 = await runAbsAsync(DOC_PLAN, ['triage', '--summary', 'fix null login bug', '--bugfix', '--files', '1', '--json'], { cwd: dir })
      if (c2.status !== 0) return `Case 2 triage 失败：${c2.stderr}`
      const j2 = JSON.parse(c2.stdout)
      if (j2.visualBrief) return 'Case 2 不应生成 visualBrief'

      // 单轮 note 不触发，多轮 note 自动触发
      const n1 = await runAbsAsync(DOC_PLAN, ['note', '--topic', 'multi-turn', '--decision', 'Use token bucket', '--open', 'Rate limit?', '--json'], { cwd: dir })
      if (n1.status !== 0) return `第 1 轮 note 失败：${n1.stderr}`
      if (JSON.parse(n1.stdout).visualBrief) return '单轮无 Case 3/4 的 note 不应提前生成 brief'

      const n2 = await runAbsAsync(DOC_PLAN, ['note', '--topic', 'multi-turn', '--exclude', 'No Redis dependency', '--json'], { cwd: dir })
      if (n2.status !== 0) return `第 2 轮 note 失败：${n2.stderr}`
      const jn2 = JSON.parse(n2.stdout)
      if (!jn2.visualBrief || jn2.visualBrief.briefKey !== 'multi-turn') return `多轮 note 未触发 visualBrief：${n2.stdout}`

      // Case 4 triage 立即生成仓外 brief
      const c4 = await runAbsAsync(DOC_PLAN, ['triage', '--summary', 'cross-module export pipeline', '--topic', 'export-pipe', '--touches-contract', '--files', '5', '--json'], { cwd: dir })
      if (c4.status !== 0) return `Case 4 triage 失败：${c4.stderr}`
      const j4 = JSON.parse(c4.stdout)
      if (!j4.visualBrief || !existsSync(j4.visualBrief.htmlPath)) return `Case 4 未产出 HTML：${c4.stdout}`
      const html = readFileSync(j4.visualBrief.htmlPath, 'utf8')
      if (!html.split('\n')[0].includes('project-forge visual-brief')) return 'Brief HTML 首行标识异常'
      const home = homedir().replace(/\\/g, '/')
      if (home.length >= 4 && html.includes(home)) return 'Brief HTML 泄露了宿主机 homedir'

      // 确认 git status 保持完全干净（零仓内污染）
      const st = await gitRun(dir, ['status', '--porcelain'])
      if (!st.ok || st.stdout.trim() !== '') return `仓外 Brief 不应污染 git status：${st.stdout}`
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['Living Brief C9：--prototype 多方向暂存、选中、XSS 转义、>512KB 与危险协议负向拦截、confirm -> stale', async () => {
    const dir = makeRepoWithFeatureMap('lb-proto')
    try {
      const protoDir = join(dir, '.tmp-protos')
      mkdirSync(protoDir, { recursive: true })
      const protoA = join(protoDir, 'dir-a.html')
      const protoB = join(protoDir, 'dir-b.png')
      const huge = join(protoDir, 'huge.html')
      writeFileSync(protoA, '<!doctype html><div>Direction A Safe Layout</div>\n', 'utf8')
      writeFileSync(protoB, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      writeFileSync(huge, 'x'.repeat(520 * 1024), 'utf8')

      const xss = '<script>alert("xss")</script>'
      const res = await runAbsAsync(DOC_PLAN, [
        'brief', '--topic', 'ui-shell', '--title', `Shell ${xss}`, '--verdict', 'Compare two layouts',
        '--affected-feature', 'export', '--flow-delta', 'Add preview drawer',
        '--prototype', `DirA=${protoA}`, '--prototype', `DirB=${protoB}`, '--prototype', 'Spec=https://example.com/ui',
        '--source-skill', 'ui-proto-gen', '--json',
      ], { cwd: dir })
      if (res.status !== 0) return `brief 挂载原型失败：${res.stderr || res.stdout}`
      const j = JSON.parse(res.stdout)
      if (j.visualBrief.prototypeCount !== 3) return `原型数量不符：${j.visualBrief.prototypeCount}`
      const paths = resolveBriefPaths(dir, 'ui-shell')
      const html = readFileSync(paths.htmlPath, 'utf8')
      if (html.includes(xss)) return 'Brief HTML 未对标题 XSS payload 做转义'
      if (!html.includes('sandbox="allow-scripts"') || !html.includes('ui-shell-prototypes/')) return '原型沙盒 iframe 或相对图片路径缺失'

      // 选定原型 + 确认快照
      const sel = await runAbsAsync(DOC_PLAN, ['brief', '--topic', 'ui-shell', '--select-prototype', 'dira', '--confirm', '--json'], { cwd: dir })
      if (sel.status !== 0) return `select+confirm 失败：${sel.stderr}`
      const jsel = JSON.parse(sel.stdout)
      if (jsel.visualBrief.selectedPrototypeId !== 'dira' || jsel.visualBrief.confirmedState !== 'confirmed') {
        return `确认态或选中原型异常：${JSON.stringify(jsel.visualBrief)}`
      }

      // 确认后再次修改 -> 自动降级为 stale
      const mut = await runAbsAsync(DOC_PLAN, ['brief', '--topic', 'ui-shell', '--verdict', 'Scope expanded after confirm', '--json'], { cwd: dir })
      if (mut.status !== 0) return `修改 brief 失败：${mut.stderr}`
      if (JSON.parse(mut.stdout).visualBrief.confirmedState !== 'stale') {
        return `确认后修改未自动降级为 stale：${mut.stdout}`
      }

      // 负向 1：超 512 KB 原型文件阻断
      const big = await runAbsAsync(DOC_PLAN, ['brief', '--topic', 'ui-shell', '--prototype', `Huge=${huge}`, '--json'], { cwd: dir })
      if (big.status !== EXIT.FACT || !big.stdout.includes('BLOCKED_PROTOTYPE_TOO_LARGE')) {
        return `超 512KB 原型未以 BLOCKED_PROTOTYPE_TOO_LARGE 拦截：status=${big.status}, out=${big.stdout}`
      }

      // 负向 2：javascript: 与 data: 协议阻断
      const jsUri = await runAbsAsync(DOC_PLAN, ['brief', '--topic', 'ui-shell', '--prototype', 'Evil=javascript:alert(1)', '--json'], { cwd: dir })
      if (jsUri.status !== EXIT.USAGE || !jsUri.stdout.includes('BLOCKED_UNSAFE_PROTOTYPE_URI')) {
        return `javascript: 原型未拦截：status=${jsUri.status}, out=${jsUri.stdout}`
      }
      const dataUri = await runAbsAsync(DOC_PLAN, ['brief', '--topic', 'ui-shell', '--prototype', 'Evil2=data:text/html,<b>x</b>', '--json'], { cwd: dir })
      if (dataUri.status !== EXIT.USAGE || !dataUri.stdout.includes('BLOCKED_UNSAFE_PROTOTYPE_URI')) {
        return `data: 原型未拦截：status=${dataUri.status}, out=${dataUri.stdout}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['Living Brief C9/C10：init 迁移（standalone vs 1:N master-prd vs child slice parentBriefKey）、workRoot 优先与 clarify 触发 stale', async () => {
    const dir = makeRepoWithFeatureMap('lb-migrate')
    try {
      // 1. Standalone init 迁移 topic -> taskId + ledger.briefKey
      upsertVisualBrief(dir, { briefKey: 'solo-topic', topicId: 'solo-topic', title: 'Solo Plan', verdict: 'Solo v1', confirm: true })
      const soloRes = await initDoc({
        repoRoot: dir, mainRoot: dir, gitDir: null, isGit: false,
        kind: 'pair', slug: 'solo-task', title: 'Solo Task', taskId: 'solo-task',
        owner: 'planner-test', topic: 'solo-topic', inPlace: true,
      })
      if (soloRes.briefMigration?.briefKey !== 'solo-task') return `standalone 迁移失败：${JSON.stringify(soloRes.briefMigration)}`
      if (readBriefSidecar(dir, 'solo-topic') !== null) return '迁移后旧 topic sidecar 应已清理'
      const soloLedger = readTaskLedger(dir, 'solo-task')
      if (soloLedger?.briefKey !== 'solo-task') return `ledger.briefKey 未回写：${JSON.stringify(soloLedger)}`

      // clarify 自动刷新并触发 stale
      const clar = clarifyDoc({ repoRoot: dir, mainRoot: dir, file: soloRes.files.find((f) => f.includes('specs/')), question: 'Scope?', decision: 'Keep local only', by: 'user', explicitBy: 'user' })
      if (clar.visualBrief?.confirmedState !== 'stale') return `clarify 后未将已确认 brief 置为 stale：${JSON.stringify(clar.visualBrief)}`

      // 2. 1:N Master PRD 迁移 topic -> master-prd，child slice 派生 parentBriefKey 且绝不覆写 Master PRD brief
      upsertVisualBrief(dir, { briefKey: 'mega-topic', topicId: 'mega-topic', title: 'Mega Master PRD', verdict: 'Master verdict' })
      const prdRes = await initDoc({
        repoRoot: dir, mainRoot: dir, gitDir: null, isGit: false,
        kind: 'prd', slug: 'mega-platform', title: 'Mega Platform PRD',
        owner: 'planner-test', multiSpec: true, topic: 'mega-topic', inPlace: true,
      })
      const masterSidecar = readBriefSidecar(dir, 'mega-platform')
      if (!masterSidecar || masterSidecar.kind !== 'master-prd') return `1:N master-prd 迁移异常：${JSON.stringify(masterSidecar)}`

      const sliceRes = await sliceSpec({
        repoRoot: dir, mainRoot: dir, gitDir: null, isGit: false,
        relatedPrd: prdRes.file, specSlug: 'mega-s1', taskId: 'mega-s1', title: 'Mega Slice 1',
        owner: 'planner-test', inPlace: true,
      })
      const childSidecar = readBriefSidecar(dir, 'mega-s1')
      const masterAfter = readBriefSidecar(dir, 'mega-platform')
      if (!childSidecar || childSidecar.parentBriefKey !== 'mega-platform' || childSidecar.kind !== 'task') {
        return `子切片 parentBriefKey 异常：${JSON.stringify(childSidecar)}`
      }
      if (!masterAfter || masterAfter.kind !== 'master-prd' || masterAfter.verdict !== 'Master verdict') {
        return `子切片意外覆写了 Master PRD Brief：${JSON.stringify(masterAfter)}`
      }

      // 3. workRoot > mainRoot 优先级实证
      const wtDir = join(dir, '.worktrees', 'impl-override')
      mkdirSync(join(wtDir, 'docs'), { recursive: true })
      writeFileSync(join(wtDir, 'docs', 'feature-map.json'), JSON.stringify({
        version: 2,
        domains: [{ id: 'wt-dom', name: 'Worktree Domain' }],
        features: [{ id: 'wt-only-feat', name: 'Worktree Feature', domain: 'wt-dom', entrypoints: ['src/wt.mjs'], modules: ['src/wt.mjs'], tests: [] }],
      }, null, 2), 'utf8')
      const projWt = projectVisualBriefViewModel({ mainRoot: dir, workRoot: wtDir, sidecar: childSidecar })
      if (projWt.featureMapSource !== 'workRoot' || !projWt.visualModel.tree.nodes.some((n) => n.id === 'wt-only-feat')) {
        return `workRoot 优先投影失败：source=${projWt.featureMapSource}`
      }
      const emptyWt = join(dir, '.worktrees', 'impl-empty-wt')
      mkdirSync(emptyWt, { recursive: true })
      const projFb = projectVisualBriefViewModel({ mainRoot: dir, workRoot: emptyWt, sidecar: childSidecar })
      if (projFb.featureMapSource !== 'mainRoot' || !projFb.visualModel.tree.nodes.some((n) => n.id === 'auth')) {
        return `workRoot 缺 feature-map 时回退 mainRoot 失败：source=${projFb.featureMapSource}`
      }

      // 4. pruneStaleBriefs 清理指定任务而不误删活跃 Master PRD
      const pruned = pruneStaleBriefs(dir, { taskId: 'solo-task' })
      if (!pruned.pruned.includes('solo-task') || !readBriefSidecar(dir, 'mega-platform')) {
        return `pruneStaleBriefs 行为异常：${JSON.stringify(pruned)}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['Living Brief C10：doc-locate/repo-map 仅显式 --topic 刷新，plan-next/flow-next 暴露 visualBrief 与交接快照', async () => {
    const dir = makeRepoWithFeatureMap('lb-wire')
    try {
      // 无 --topic 严格零写入
      const locNoTopic = await runAbsAsync(DOC_LOCATE, ['--query', 'login', '--json'], { cwd: dir })
      if (locNoTopic.status !== 0) return `doc-locate 失败：${locNoTopic.stderr}`
      if (existsSync(resolveBriefsDir(dir))) return 'doc-locate 无 --topic 时不得创建仓外 briefs'

      // 显式 --topic 刷新仓外 brief
      const locWithTopic = await runAbsAsync(DOC_LOCATE, ['--query', 'login', '--topic', 'loc-topic', '--json'], { cwd: dir })
      if (locWithTopic.status !== 0) return `doc-locate --topic 失败：${locWithTopic.stderr}`
      if (!readBriefSidecar(dir, 'loc-topic')) return 'doc-locate --topic 未刷新仓外 Brief'

      const mapWithTopic = await runAbsAsync(REPO_MAP, ['.', '--topic', 'map-topic', '--json'], { cwd: dir })
      if (mapWithTopic.status !== 0) return `repo-map --topic 失败：${mapWithTopic.stderr}`
      if (!readBriefSidecar(dir, 'map-topic')) return 'repo-map --topic 未刷新仓外 Brief'

      // plan-next 与 buildPlanHandoff + flow next 均暴露 visualBrief
      upsertVisualBrief(dir, { briefKey: 'map-topic', topicId: 'map-topic', title: 'Map Topic', verdict: 'Confirmed', confirm: true })
      const planState = await evaluatePlanNextState({ repoRoot: dir, mainRoot: dir, isGit: true })
      if (!planState.visualBrief || planState.visualBrief.confirmedState !== 'confirmed') {
        return `evaluatePlanNextState 未暴露 visualBrief：${JSON.stringify(planState.visualBrief)}`
      }
      const handoff = buildPlanHandoff({ state: planState })
      if (!handoff.fields.visualBrief || !handoff.prompt.includes('Living Visual Brief')) {
        return `buildPlanHandoff 未注入 visualBrief 快照：${handoff.prompt}`
      }
      const flowNext = await runAbsAsync(FLOW, ['next', '--json'], { cwd: dir })
      if (flowNext.status !== 0) return `flow next 失败：${flowNext.stderr}`
      const fnJson = JSON.parse(flowNext.stdout)
      if (!fnJson.visualBrief || fnJson.visualBrief.briefKey !== 'map-topic') {
        return `flow next 未暴露 visualBrief：${JSON.stringify(fnJson.visualBrief)}`
      }

      // 校验生成的 Living Visual Brief 与 Architecture Map 内联 <script> 均为合法 JS，且长中文标题按视觉宽度截断
      const assertScriptsParse = (htmlText, label) => {
        const blocks = [...htmlText.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi)]
        let jsCount = 0
        for (const m of blocks) {
          if (/type=["']application\/json["']/i.test(m[0])) continue
          jsCount += 1
          try {
            new Script(m[1])
          } catch (err) {
            return `${label} 内联 <script> 语法错误：${err.message}`
          }
        }
        return jsCount > 0 ? null : `${label} 缺少可执行 <script> 块`
      }
      const briefHtml = readFileSync(resolveBriefPaths(dir, 'map-topic').htmlPath, 'utf8')
      const briefErr = assertScriptsParse(briefHtml, 'living-brief')
      if (briefErr) return briefErr

      writeFileSync(join(dir, 'docs', 'feature-map.json'), JSON.stringify({
        version: 2,
        domains: [{ id: 'cjk', name: '中文长标题视觉宽度测试域' }],
        features: [{
          id: 'cjk-long',
          name: '参数注册表帮助声明与读取点三重对拍超长中文标题截断验证',
          domain: 'cjk',
          entrypoints: ['src/auth.mjs'],
          modules: ['src/auth.mjs'],
          tests: [],
        }],
      }, null, 2), 'utf8')
      const archRes = renderArchitectureMapFromRepo(dir)
      const archHtml = readFileSync(archRes.absPath, 'utf8')
      const archErr = assertScriptsParse(archHtml, 'architecture-map')
      if (archErr) return archErr
      if (archHtml.includes('参数注册表帮助声明与读取点三重对拍...')) {
        return '长中文标题未按视觉宽度（全角=2）截断，会导致 SVG 卡片溢出'
      }
      // 同步校验真实仓库已提交的 docs/architecture-map.html 内联脚本合法性
      const repoArchPath = join(process.cwd(), 'docs', 'architecture-map.html')
      if (existsSync(repoArchPath)) {
        const repoArchErr = assertScriptsParse(readFileSync(repoArchPath, 'utf8'), 'repo docs/architecture-map.html')
        if (repoArchErr) return repoArchErr
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])
}
