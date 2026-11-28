/**
 * fixtures-onboarding.mjs —— 外部新项目接管断点、根仓 wrapDir、有无 dev-review × 五态（2x5）与 5 形态端到端正反矩阵（C1-C9）。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { sniffLayeredCommands } from '../../kit/skills/lib/profile-sniffer.mjs'
import { resolveRepoRoots } from '../../kit/skills/lib/git.mjs'
import { createGitHubClient } from '../../kit/skills/lib/platform.mjs'
import { handleStart } from '../../kit/skills/dev-flow/scripts/flow-inspect.mjs'
import { handleExplore } from '../../kit/skills/dev-flow/scripts/flow-explore.mjs'
import { handleNext } from '../../kit/skills/dev-flow/scripts/flow-next.mjs'
import { handleFinalize, handleVerify, handleSubmit } from '../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs'
import { handleClaim, handleMerge } from '../../kit/skills/dev-flow/scripts/flow-merge.mjs'
import { handleRecord } from '../../kit/skills/dev-review/scripts/review-ledger.mjs'
import { reviewProject } from '../review.mjs'
import { verifyClaims } from '../lib/claims.mjs'
import { checkEquip, equip } from '../equip.mjs'
import { scan as handoffScan } from '../handoff.mjs'
import { SKILL_ROOT, gitCommitFast, gitInit, gitInitBare, gitSync, issueTokenFor, rmTree, runNode, tmpProject } from './fixtures-helpers.mjs'

function runLocal(dir, relScript, args = []) {
  return spawnSync(process.execPath, [join(dir, relScript), ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60000,
  })
}

function createMemoryGhHarness(repoFull = 'acme/demo', login = 'alice') {
  const prs = new Map()
  const issues = new Map([[10, { number: 10, title: 'seed issue', state: 'open' }]])
  const comments = new Map()
  let nextPr = 101

  const client = {
    tier: 'gh-cli',
    login,
    async getAuthLogin() { return { ok: true, login } },
    async getIssue(_repo, num) {
      const it = issues.get(Number(num)) ?? { number: Number(num), title: `issue-${num}`, state: 'open', body: 'seed body' }
      return { ok: true, number: it.number, title: it.title, state: it.state, body: it.body, url: `https://github.com/${repoFull}/issues/${num}` }
    },
    async listComments(_repo, num) { return { ok: true, comments: comments.get(Number(num)) ?? [] } },
    async addLabel() { return { ok: true } },
    async removeLabel() { return { ok: true } },
    async listPrsForBranch(_repo, branch) {
      return { ok: true, prs: [...prs.values()].filter((p) => p.head === branch && p.state === 'OPEN') }
    },
    async getCommitChecks() { return { ok: true, skipped: true } },
    async getPr(_repo, num) {
      const p = prs.get(Number(num))
      return p ? { ok: true, pr: p, state: p.state, merged: p.state === 'MERGED' } : { ok: false, error: 'not found' }
    },
    async createPr({ head, base, title, body }) {
      const number = nextPr++
      const pr = { number, head, base, title, body, state: 'OPEN', url: `https://github.com/${repoFull}/pull/${number}` }
      prs.set(number, pr)
      comments.set(number, [])
      return { ok: true, number, url: pr.url, state: 'OPEN' }
    },
    async mergePr({ number }) {
      const pr = prs.get(Number(number))
      if (!pr) return { ok: false, error: 'no pr' }
      pr.state = 'MERGED'
      return { ok: true, merged: true, state: 'MERGED' }
    },
    async postComment({ number, body }) {
      const n = Number(number)
      if (!comments.has(n)) comments.set(n, [])
      const entry = { id: comments.get(n).length + 1, body, user: { login } }
      comments.get(n).push(entry)
      return { ok: true, comment: entry }
    },
  }
  const ghProbe = { client, env: { trackB: { tier: 'gh-cli', login, available: true }, trackA: { https: true, ssh: true } } }
  return { client, ghProbe, prs, comments }
}

function calibrateAgentsText(text, testCmd = 'npm test', highRisk = 'src/') {
  return text
    .replace(/<!--\s*project-forge:\s*fill 项目定位：[^\n]*-->/g, '示例项目：验证项目接管闭环。')
    .replace(
      /quick-test:[^\n]*\nfull-test:[^\n]*\nsmoke-verify:[^\n]*\nmerge-gate:[^\n]*\narch-rules:[^\n]*\nhigh-risk:[^\n]*\ndo-not-edit:[^\n]*/m,
      [
        `quick-test: ${testCmd}`,
        `full-test: ${testCmd}`,
        'smoke-verify: none',
        `merge-gate: ${testCmd}`,
        'arch-rules: none',
        `high-risk: ${highRisk}`,
        'do-not-edit: docs/archive/',
      ].join('\n'),
    )
    .replace(/<!--\s*project-forge:\s*fill Dev Profile：[^\n]*-->\n*/g, '')
    .replace(/<!--\s*project-forge:\s*fill 模块入口：[^\n]*-->/g, '- 主入口：`README.md`')
    .replace(/<!--\s*project-forge:\s*fill 关键不变量：[^\n]*-->/g, '- 核心变更须保持测试通过。')
    .replace(/<!--\s*project-forge:\s*fill 构建与验证命令：[^\n]*-->\n*/g, '')
    .replace(/```sh\n# 按项目实际补齐构建、检查与测试命令\n```/g, `\`\`\`sh\n${testCmd}\n\`\`\``)
    .replace(/<!--\s*project-forge:\s*fill 项目特有红线：[^\n]*-->/g, '- 暂不增加额外限制。')
    .replace(/<!--\s*project-forge:\s*fill 高风险路径：[^\n]*-->/g, `- \`${highRisk}\`：关键边界`)
    .replace(/\|\s*`<核心模块或公开契约>`\s*\|[^\n]*\n/g, '| `README.md` | `AGENTS.md` |\n')
    .replace(/<!--\s*project-forge:\s*fill 改哪看哪：[^\n]*-->\n*/g, '')
    .replace(
      /<!-- project-forge: begin 取舍 -->([\s\S]*?)```text\n```/,
      '<!-- project-forge: begin 取舍 customized -->$1```text\n- `license`：MIT，测试项目\n- `no-tdd`：暂不单设 TDD\n- `no-ci`：示例暂不设 CI\n- `no-collab-templates`：暂不设协作者模板\n- `project-kind`：示例库\n- `private`：公开示例\n```',
    )
}

function setupMatrixRepo(tier, role, { highRiskFile = false, weakTest = false, caseType = 2 } = {}) {
  const files = {
    '.gitignore': '.worktrees/\n',
    'README.md': '# matrix\n\n矩阵兼容性测试仓库。\n',
    'package.json': JSON.stringify({
      name: `mx-${tier}-${role}`,
      version: '1.0.0',
      ...(role !== 'local-only' && role !== 'generic-git' ? { repository: 'https://github.com/acme/demo.git' } : {}),
      scripts: { test: 'node test/ok.test.mjs' },
    }, null, 2) + '\n',
    'AGENTS.md': [
      '# matrix',
      '',
      '```yaml',
      'quick-test: node test/ok.test.mjs',
      'full-test: node test/ok.test.mjs',
      'smoke-verify: none',
      'merge-gate: node test/ok.test.mjs',
      'arch-rules: none',
      'high-risk: src/core/',
      'do-not-edit: docs/archive/, docs/frozen/',
      '```',
      '',
      '## 取舍',
      '',
      '```text',
      '- `license`：MIT',
      '```',
      '',
    ].join('\n'),
    'src/ok.mjs': 'export const ok = 1\n',
    'src/core/key.mjs': 'export const k = 1\n',
    'docs/frozen/lock.md': '# frozen\n',
    'test/ok.test.mjs': 'import assert from "node:assert/strict"\nassert.equal(1, 1)\nassert.equal(2, 2)\n',
  }
  if (caseType >= 4) {
    files['docs/specs/261118-issue88-mx-spec.md'] = '---\nkind: spec\ntitle: mx\nstatus: approved\nowner: planner-bob\napproved: true\nplan_critique: passed\n---\n\n# SPEC: mx\n\n## 要解决的问题\n\n高风险测试。\n\n## 冻结的验收标准\n\n- [ ] C1: 通过\n'
    files['docs/todo/261118-issue88-mx-todo.md'] = '---\nkind: todo\ntitle: mx\nstatus: active\nowner: planner-bob\n---\n\n# Todo: mx\n\n## 验收标准与执行清单\n\n- [ ] C1: 通过\n'
  }
  const dir = tmpProject(files)
  const bares = []
  gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })

function makeBare() {
  const bare = mkdtempSync(join(tmpdir(), 'pf-bare-'))
  gitInitBare(bare)
  return { dir: bare, url: pathToFileURL(bare).href }
}

  let prHead = null
  if (role === 'maintainer') {
    const bare = makeBare()
    bares.push(bare.dir)
    gitSync(dir, ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'])
    gitSync(dir, ['remote', 'set-url', '--push', 'origin', bare.url])
    gitSync(dir, ['push', '-u', 'origin', 'main'])
  } else if (role === 'contributor-fork') {
    const forkBare = makeBare()
    const upstreamBare = makeBare()
    bares.push(forkBare.dir, upstreamBare.dir)
    gitSync(dir, ['remote', 'add', 'origin', 'https://github.com/forker/demo.git'])
    gitSync(dir, ['remote', 'add', 'upstream', 'https://github.com/acme/demo.git'])
    gitSync(dir, ['remote', 'set-url', '--push', 'origin', forkBare.url])
    gitSync(dir, ['remote', 'set-url', '--push', 'upstream', upstreamBare.url])
    gitSync(dir, ['push', '-u', 'origin', 'main'])
    gitSync(dir, ['push', 'upstream', 'main'])
  } else if (role === 'generic-git') {
    const bare = makeBare()
    bares.push(bare.dir)
    gitSync(dir, ['remote', 'add', 'origin', 'https://git.internal.local/team/app.git'])
    gitSync(dir, ['remote', 'set-url', '--push', 'origin', bare.url])
    gitSync(dir, ['push', '-u', 'origin', 'main'])
  } else if (role === 'inbound-external-pr') {
    const bare = makeBare()
    bares.push(bare.dir)
    gitSync(dir, ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'])
    gitSync(dir, ['remote', 'set-url', '--push', 'origin', bare.url])
    gitSync(dir, ['push', '-u', 'origin', 'main'])
    prHead = gitSync(dir, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  }

  return { dir, bares, prHead, highRiskFile, weakTest }
}

export function registerOnboardingCases(cases) {
  cases.push(['C1：wrapDir 根仓命令缺少包管理器前缀与多生态嗅探兼容', async () => {
    const lockSpecs = [
      ['npm', 'package-lock.json', '{}', 'npm test', 'npm run check', 'npm run lint', 'npm run build'],
      ['pnpm', 'pnpm-lock.yaml', 'lockfileVersion: 9.0\n', 'pnpm test', 'pnpm check', 'pnpm lint', 'pnpm build'],
      ['yarn', 'yarn.lock', '# yarn\n', 'yarn test', 'yarn check', 'yarn lint', 'yarn build'],
      ['bun', 'bun.lock', '{}\n', 'bun test', 'bun check', 'bun lint', 'bun build'],
    ]
    for (const [pm, lockName, lockBody, expQuick, expFull, expLint, expBuild] of lockSpecs) {
      const rootDir = tmpProject({
        [lockName]: lockBody,
        'package.json': JSON.stringify({
          name: `${pm}-root`,
          scripts: { test: 'node -e "0"', check: 'node -e "0"', lint: 'node -e "0"', build: 'node -e "0"' },
        }),
      })
      try {
        const res = sniffLayeredCommands(rootDir, { kinds: ['node'] })
        if (res.quickTest !== expQuick || res.fullTest !== expFull || res.lint !== expLint || res.build !== expBuild) {
          return `${pm} 根仓命令缺少包管理器前缀或拼装错误：${JSON.stringify({ quickTest: res.quickTest, fullTest: res.fullTest, lint: res.lint, build: res.build })}`
        }
      } finally { rmTree(rootDir) }
    }

    // 子包多包管理器命令保留 --prefix / --dir / --cwd 且无 subshell cd 切换
    const monoDir = tmpProject({
      'package.json': JSON.stringify({ name: 'mono', private: true }),
      'packages/web/pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
      'packages/web/package.json': JSON.stringify({ name: 'web', scripts: { test: 'vitest' } }),
      'packages/api/package-lock.json': '{}',
      'packages/api/package.json': JSON.stringify({ name: 'api', scripts: { test: 'node --test' } }),
      'packages/ui/yarn.lock': '# yarn\n',
      'packages/ui/package.json': JSON.stringify({ name: 'ui', scripts: { test: 'jest' } }),
      'packages/edge/bun.lock': '{}\n',
      'packages/edge/package.json': JSON.stringify({ name: 'edge', scripts: { test: 'bun test' } }),
    })
    try {
      const res = sniffLayeredCommands(monoDir, { kinds: ['node'] })
      const raw = JSON.stringify(res)
      if (/\bcd\s+[^&]+&&|\(cd\s+/.test(raw)) return `多包命令不得含 subshell cd 切换：${raw}`
      const subText = JSON.stringify(res.packages)
      if (!subText.includes('pnpm --dir packages/web test')
        || !subText.includes('npm --prefix packages/api test')
        || !subText.includes('yarn --cwd packages/ui test')
        || !subText.includes('bun --cwd packages/edge test')) {
        return `子包命令目录参数丢失：${subText}`
      }
    } finally { rmTree(monoDir) }

    // 反面：默认 "no test specified" 不得生成 quickTest
    const noTestDir = tmpProject({
      'package.json': JSON.stringify({ name: 'empty-test', scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    })
    try {
      const res = sniffLayeredCommands(noTestDir, { kinds: ['node'] })
      if (res.quickTest) return `无效 no test specified 误报为 quickTest：${res.quickTest}`
    } finally { rmTree(noTestDir) }

    // 多语言与零清单纯文档仓容错
    const ecoShapes = [
      [{ 'pyproject.toml': '[project]\nname="py"\n', 'tests/test_a.py': 'def test_ok(): pass\n' }, ['python']],
      [{ 'Cargo.toml': '[package]\nname="rs"\nversion="0.1.0"\n' }, ['rust']],
      [{ 'go.mod': 'module example.com/app\n\ngo 1.22\n' }, ['go']],
      [{ 'pom.xml': '<project><modelVersion>4.0.0</modelVersion></project>\n' }, ['java']],
      [{ 'README.md': '# docs only\n\n纯文档仓。\n' }, []],
    ]
    for (const [files, kinds] of ecoShapes) {
      const dir = tmpProject(files)
      try {
        const res = sniffLayeredCommands(dir, { kinds })
        if (!res || typeof res !== 'object') return `生态 ${kinds.join(',') || 'docs'} 返回结构异常`
        if (kinds.length === 0 && (res.quickTest || res.fullTest || res.lint || res.build)) {
          return `零清单纯文档仓不应编造命令：${JSON.stringify({ quickTest: res.quickTest, fullTest: res.fullTest })}`
        }
      } finally { rmTree(dir) }
    }
    return true
  }])

  cases.push(['C2/C4：Dev Profile 自动预填、校准免漂移与统一模板体积预算', async () => {
    const nodeDir = tmpProject({
      'package-lock.json': '{}',
      'package.json': JSON.stringify({ name: 'node-ok', version: '1.0.0', scripts: { test: 'node --version', check: 'node --version' } }),
      'README.md': '# node-ok\n\n测试节点项目示例，包含标准包管理命令脚本并用于校准验证。\n',
      'src/index.mjs': 'export const ok = 1\n',
    })
    gitInit(nodeDir, { branch: 'main', name: 'alice', email: 'alice@acme-fixture.dev' })
    const docsDir = tmpProject({ 'README.md': '# pure-docs\n\n纯文档仓库说明文档示例。\n' })
    const bootDir = tmpProject({})

    try {
      // 1. 统一完整装配，且预填真实 Node 命令
      const cDefault = await runNode('compose-agents.mjs', [nodeDir, '--no-backup'])
      if (cDefault.status !== 0) return `compose-agents 默认渲染失败：${cDefault.stderr}`
      const defaultAgents = readFileSync(join(nodeDir, 'AGENTS.md'), 'utf8')
      if (!defaultAgents.includes('quick-test: npm test') || !defaultAgents.includes('full-test: npm run check')) {
        return `Node 仓未预填真实 Dev Profile 命令：\n${defaultAgents.slice(0, 1200)}`
      }
      if (!defaultAgents.includes('独立审查') || !defaultAgents.includes('审查者直接合')) {
        return '默认渲染未保留独立审查与审查者直接合契约'
      }
      const defaultBytes = Buffer.byteLength(defaultAgents, 'utf8')
      if (defaultBytes >= 24576) return `默认 AGENTS.md 超过 24KB 推荐预算：${defaultBytes}`

      // 2. 纯文档仓命令与 arch-rules 默认 none，无 fill Dev Profile 标记
      const cDocs = await runNode('compose-agents.mjs', [docsDir, '--no-backup'])
      if (cDocs.status !== 0) return `纯文档仓 compose-agents 失败：${cDocs.stderr}`
      const docsAgents = readFileSync(join(docsDir, 'AGENTS.md'), 'utf8')
      if (!docsAgents.includes('quick-test: none') || !docsAgents.includes('arch-rules: none') || !docsAgents.includes('do-not-edit: docs/archive/')) {
        return `纯文档仓 Dev Profile 默认值缺失：\n${docsAgents.slice(0, 1200)}`
      }
      if (docsAgents.includes('fill Dev Profile')) return '纯文档仓全部预填为非占位却仍残留 fill Dev Profile 标记'
      if (!/^##\s+高风险路径/m.test(docsAgents)) {
        return '高风险路径标题未保持 ^##\\s+高风险路径 前缀'
      }

      // 3. 统一装配后校准 Node 仓 Dev Profile 与占位，compose-agents --check 与 review.mjs 均退出 0，且再次刷新保护校准值
      const eqFull = await runNode('equip.mjs', [nodeDir, '--no-backup'])
      if (eqFull.status !== 0) return `equip 失败：${eqFull.stderr}`
      const calibrated = calibrateAgentsText(defaultAgents, 'npm test', 'src/')
        .replace('quick-test: npm test', 'quick-test: npm run test -- --fast')
      writeFileSync(join(nodeDir, 'AGENTS.md'), calibrated, 'utf8')
      const chkCal = await runNode('compose-agents.mjs', [nodeDir, '--check'])
      if (chkCal.status !== 0) return `已校准 Dev Profile 却误报 --check 失败：${chkCal.stdout}${chkCal.stderr}`
      const revCal = await runNode('review.mjs', [nodeDir, '--json'])
      if (revCal.status !== 0) return `校准并补全后 review.mjs 未退出 0：status=${revCal.status} out=${revCal.stdout}`
      await runNode('compose-agents.mjs', [nodeDir, '--no-backup'])
      if (!readFileSync(join(nodeDir, 'AGENTS.md'), 'utf8').includes('quick-test: npm run test -- --fast')) {
        return 'compose-agents 刷新时覆盖了用户已校准的 Dev Profile'
      }

      // 4. bootstrap-empty 后直接跑 compose --check 与 review 退出 0
      const eqBoot = await runNode('equip.mjs', [bootDir, '--bootstrap-empty', '--stack', 'node', '--no-backup'])
      if (eqBoot.status !== 0) return `bootstrap-empty 失败：${eqBoot.stderr}`
      const chkBoot = await runNode('compose-agents.mjs', [bootDir, '--check'])
      const revBoot = await runNode('review.mjs', [bootDir])
      if (chkBoot.status !== 0 || revBoot.status !== 0) {
        return `bootstrap-empty 后校验未全绿：compose=${chkBoot.status}, review=${revBoot.status}`
      }
      return true
    } finally {
      rmTree(nodeDir)
      rmTree(docsDir)
      rmTree(bootDir)
    }
  }])

  cases.push(['C3：claims.mjs 路径核查与占位豁免正反双向', async () => {
    const okDir = tmpProject({
      'README.md': '# ok\n\n说明文本。\n',
      'AGENTS.md': [
        '# ok',
        '',
        '```yaml',
        'do-not-edit: docs/archive/',
        '```',
        '',
        '## 上下文阅读护栏',
        '',
        '- **按序读取**：`AGENTS.md` -> `docs/TDD.md`（若存在）',
        '- **默认不读**：`docs/archive/`',
        '',
        '## 改哪看哪',
        '',
        '| 这次动了 | 必须一起看 |',
        '| --- | --- |',
        '| `<核心模块或公开契约>` | `docs/TDD.md`、`<对应测试与 README>` |',
        '',
        '## 取舍',
        '',
        '```text',
        '- `license`：MIT',
        '- `no-tdd`：无单独设计稿',
        '- `no-ci`：无 CI',
        '- `no-collab-templates`：无协作模板',
        '- `no-kit`：暂不装 kit',
        '- `project-kind`：示例',
        '- `private`：公开',
        '```',
        '',
      ].join('\n'),
    })
    const badDir = tmpProject({
      'README.md': '# bad\n',
      'AGENTS.md': '# bad\n\n执行脚本见 `scripts/missing-real-tool.mjs`。\n',
    })
    try {
      const cOk = verifyClaims(readFileSync(join(okDir, 'AGENTS.md'), 'utf8'), {}, (rel) => existsSync(join(okDir, rel)))
      const pathOk = cOk.find((r) => r.id === 'claim.path')
      if (pathOk && !pathOk.ok) return `docs/archive 与尖括号占位表格行被误报为路径缺失：${pathOk.detail}`

      const cBad = verifyClaims(readFileSync(join(badDir, 'AGENTS.md'), 'utf8'), {}, (rel) => existsSync(join(badDir, rel)))
      const pathBad = cBad.find((r) => r.id === 'claim.path')
      if (!pathBad || pathBad.ok) return `真实缺失路径未触发 claim.path 失败：${JSON.stringify(pathBad)}`
      const revBad = await reviewProject(badDir)
      if (revBad.missing.length === 0) return 'reviewProject 未因真实缺失路径产生缺口'
      const revCli = await runNode('review.mjs', [badDir])
      if (revCli.status !== 1) return `存在真实缺失路径时 review.mjs 应退出 1，实际=${revCli.status}`
      return true
    } finally {
      rmTree(okDir)
      rmTree(badDir)
    }
  }])

  cases.push(['C7：equip --check 深度一致性校验（核心技能、lib 导入断链、frontmatter）', async () => {
    const dir = tmpProject({ 'README.md': '# eq\n', 'src/index.mjs': 'export const a = 1\n' })
    try {
      const eq = await runNode('equip.mjs', [dir, '--no-backup'])
      if (eq.status !== 0) return `equip 失败：${eq.stderr}`
      const chk = await runNode('equip.mjs', [dir, '--check'])
      if (chk.status !== 0) return `完好仓 equip --check 应返回 0：${chk.stdout}${chk.stderr}`

      // 合法 --adopt-custom 仍退出 0
      const flowDoc = join(dir, '.agents/skills/dev-flow/SKILL.md')
      writeFileSync(flowDoc, `${readFileSync(flowDoc, 'utf8')}\n<!-- local note -->\n`, 'utf8')
      const ad1 = await runNode('equip.mjs', [dir, '--adopt-custom', 'dev-flow/SKILL.md', '--no-backup'])
      if (ad1.status !== 0) return `--adopt-custom dev-flow/SKILL.md 失败：${ad1.stderr}`
      if ((await runNode('equip.mjs', [dir, '--check'])).status !== 0) {
        return '合法登记 --adopt-custom 后 equip --check 未退出 0'
      }

      // 断链 import（即使 --adopt-custom 哈希已登记）必须退出 1
      const flowJs = join(dir, '.agents/skills/dev-flow/scripts/flow.mjs')
      const origFlowJs = readFileSync(flowJs, 'utf8')
      writeFileSync(flowJs, `import { missingFn } from '../../lib/missing-ghost.mjs'\n${origFlowJs}`, 'utf8')
      await runNode('equip.mjs', [dir, '--adopt-custom', 'dev-flow/scripts/flow.mjs', '--no-backup'])
      const brokenImp = await runNode('equip.mjs', [dir, '--check'])
      if (brokenImp.status === 0 || checkEquip(dir).ok) {
        return '已安装脚本存在断链相对导入 lib/*.mjs 时 equip --check 竟退出 0'
      }
      await runNode('equip.mjs', [dir, '--restore', 'dev-flow', '--no-backup'])

      // 无效 YAML frontmatter（即使 --adopt-custom 哈希已登记）必须退出 1
      writeFileSync(flowDoc, '# broken without frontmatter\n', 'utf8')
      await runNode('equip.mjs', [dir, '--adopt-custom', 'dev-flow/SKILL.md', '--no-backup'])
      const badFm = await runNode('equip.mjs', [dir, '--check'])
      if (badFm.status === 0 || checkEquip(dir).ok) {
        return 'SKILL.md 缺少合法 YAML frontmatter name/description 时 equip --check 竟退出 0'
      }
      await runNode('equip.mjs', [dir, '--restore', 'dev-flow', '--no-backup'])

      // 故意禁用并经 equip 写入 disabledSkills 墓碑后，不得死锁 equip --check
      rmTree(join(dir, '.agents/skills/dev-govern'))
      await runNode('equip.mjs', [dir, '--no-backup'])
      const disChk = await runNode('equip.mjs', [dir, '--check'])
      const disReport = checkEquip(dir)
      if (disChk.status !== 0 || !disReport.ok || !disReport.disabledSkills.includes('dev-govern')) {
        return `故意禁用技能写入 disabledSkills 墓碑后不应死锁 equip --check: status=${disChk.status} ok=${disReport.ok} disabled=${JSON.stringify(disReport.disabledSkills)} broken=${JSON.stringify(disReport.brokenImports)}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['C8：handoff --scan 单反引号残留指针与多反引号元示例豁免', async () => {
    const dir = tmpProject({
      'README.md': [
        '# demo',
        '',
        '双反引号元示例：`` `references/arch.md` `` 不应报错。',
        '',
        '```md',
        '围栏内 `references/collaboration.md` 与 `scripts/equip.mjs` 不应报错。',
        '```',
        '',
        '本地自建同名：`scripts/local-only-exists.mjs`。',
        '',
      ].join('\n'),
      'AGENTS.md': [
        '# demo',
        '',
        '见 `references/collaboration.md` 与 `scripts/survey.mjs`。',
        '',
      ].join('\n'),
      'scripts/local-only-exists.mjs': 'export const ok = 1\n',
    })
    try {
      const bad = JSON.parse((await runNode('handoff.mjs', [dir, '--scan', '--json'])).stdout)
      const targets = bad.danglingPointers.map((p) => p.target)
      if (bad.clean !== false || !targets.includes('references/collaboration.md') || !targets.includes('scripts/survey.mjs')) {
        return `单反引号悬空指针未检出：${JSON.stringify(bad.danglingPointers)}`
      }
      if (targets.includes('references/arch.md')) return '多反引号元示例误报为悬空指针'

      // 清除悬空指针，且验证真实自建同名本地文件 + 多反引号 + 围栏内全部退出 0
      writeFileSync(join(dir, 'AGENTS.md'), '# demo\n\n规则已内联。见 `references/local-own.md` 与 `scripts/survey.mjs`。\n', 'utf8')
      mkdirSync(join(dir, 'references'), { recursive: true })
      writeFileSync(join(dir, 'references/local-own.md'), '# own\n', 'utf8')
      writeFileSync(join(dir, 'scripts/survey.mjs'), 'export const own = 1\n', 'utf8')
      writeFileSync(join(dir, 'README.md'), readFileSync(join(dir, 'README.md'), 'utf8') + '\n本地自建：`references/local-own.md`。\n', 'utf8')

      const ver = await runNode('handoff.mjs', [dir, '--verify'])
      const good = handoffScan(dir)
      if (ver.status !== 0 || !good.clean) {
        return `洁净与本地同名路径应通过 handoff --verify：status=${ver.status} scan=${JSON.stringify(good.danglingPointers)}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  const runRoleMatrixForMode = async (mode) => {
    const cleanups = []
    const hasReviewKit = mode === 'full-kit'
    try {
      for (const role of ['local-only', 'maintainer', 'contributor-fork', 'generic-git', 'inbound-external-pr']) {
        const { dir, bares, prHead } = setupMatrixRepo(mode, role, { caseType: 2 })
        cleanups.push(dir, ...bares)
        equip(dir, { noBackup: true })
        if (!hasReviewKit) rmTree(join(dir, '.agents', 'skills', 'dev-review'))
        gitCommitFast(dir, `equip ${mode}`)

        const flowRel = '.agents/skills/dev-flow/scripts/flow.mjs'
        const roots = await resolveRepoRoots(dir)
        const gh = createMemoryGhHarness('acme/demo', 'alice')

        if (role === 'inbound-external-pr') {
          if (!hasReviewKit) {
            const ins = runLocal(dir, flowRel, ['inspect', '--external-pr', '42'])
            if (ins.stdout.includes('review-pack.mjs')) return `no-dev-review inspect 外部 PR 不应打印 review-pack.mjs：${ins.stdout}`
            const stCli = runLocal(dir, flowRel, ['start', '--external-pr', '42', '--json'])
            if (stCli.status !== 3 || !`${stCli.stdout}${stCli.stderr}`.includes('BLOCKED_REQUIRES_DEV_REVIEW')) {
              return `no-dev-review 外部 PR start 未阻断为 BLOCKED_REQUIRES_DEV_REVIEW：status=${stCli.status}`
            }
            const ledgerDir = join(dir, '.worktrees', '.state', 'tasks')
            mkdirSync(ledgerDir, { recursive: true })
            writeFileSync(join(ledgerDir, 'review-pr-42.json'), JSON.stringify({
              schemaVersion: 2, taskId: 'review-pr-42', role: 'inbound-external-pr', status: 'review-ready', prNumber: 42,
            }), 'utf8')
            const nxExt = runLocal(dir, flowRel, ['next', '--task', 'review-pr-42', '--json'])
            const vExt = runLocal(dir, flowRel, ['verify', '--task', 'review-pr-42'])
            if (!nxExt.stdout.includes('BLOCKED_REQUIRES_DEV_REVIEW') || vExt.status !== 3 || vExt.stdout.includes('review-pack.mjs')) {
              return `no-dev-review 外部 PR next/verify 未正确阻断：next=${nxExt.stdout} verify=${vExt.status}`
            }
          } else {
            const stFull = runLocal(dir, flowRel, ['start', '--external-pr', '42', '--pr-ref', prHead, '--json'])
            if (stFull.status !== 0) return `full-kit 外部 PR start 失败：${stFull.stderr}`
            const vBlocked = runLocal(dir, flowRel, ['verify', '--task', 'review-pr-42'])
            if (vBlocked.status !== 3) return `full-kit 外部 PR 未扫描 verify 应退出 3：${vBlocked.status}`
          }
          continue
        }

        // local-only / maintainer / contributor-fork / generic-git
        const taskId = `mx-${mode}-${role}`
        const useMockApi = role === 'maintainer' || role === 'contributor-fork'
        if (useMockApi) {
          const st = await handleStart({ task: taskId, case: '2', slug: taskId, issue: '10', _ghClient: gh.client, _ghProbe: gh.ghProbe }, roots)
          if (st.exitCode !== 0) return `start(${mode}/${role}) 失败：${st.exitCode}`
          const cl = await handleClaim({ task: taskId, agent: 'alice', _ghClient: gh.client, _ghProbe: gh.ghProbe }, roots)
          if (cl.exitCode !== 0) return `claim(${mode}/${role}) 失败`
          const ex = await handleExplore({ task: taskId }, roots)
          if (ex.exitCode !== 0) return `explore(${mode}/${role}) 失败：${ex.exitCode}`
        } else {
          const stCli = runLocal(dir, flowRel, ['start', '--task', taskId, '--case', '2', '--slug', taskId, '--agent', 'alice', '--no-issue', '--reason', '回归夹具验证多角色生命周期矩阵', '--json'])
          if (stCli.status !== 0) return `cli start(${mode}/${role}) 失败：${stCli.stderr}`
          if (role === 'generic-git') {
            const clCli = runLocal(dir, flowRel, ['claim', '--task', taskId, '--agent', 'alice'])
            if (clCli.status !== 0) return `cli claim(${mode}/${role}) 失败：${clCli.stderr}`
          }
          const exCli = runLocal(dir, flowRel, ['explore', '--task', taskId])
          if (exCli.status !== 0) return `cli explore(${mode}/${role}) 失败：${exCli.stderr}`
        }

        const implAbs = join(dir, '.worktrees', `impl-${taskId}`)
        writeFileSync(join(implAbs, 'src/ok.mjs'), `export const ok = '${mode}-${role}'\n`, 'utf8')
        gitSync(implAbs, ['add', '-A'])
        gitSync(implAbs, ['commit', '-qm', `impl ${mode} ${role}`])

        const vRes = runLocal(dir, flowRel, ['verify', '--task', taskId, '--mode', 'full'])
        if (vRes.status !== 0) return `verify(${mode}/${role}) 失败：${vRes.stderr}`

        if (useMockApi) {
          const sub = await handleSubmit({ task: taskId, agent: 'alice', _ghClient: gh.client, _ghProbe: gh.ghProbe }, roots)
          if (sub.exitCode !== 0) return `submit(${mode}/${role}) 失败：${sub.exitCode}`
        } else {
          const subCli = runLocal(dir, flowRel, ['submit', '--task', taskId, '--agent', 'alice'])
          if (subCli.status !== 0) return `cli submit(${mode}/${role}) 失败：${subCli.stderr}`
          if (!hasReviewKit && subCli.stdout.includes('review-pack.mjs')) {
            return `no-dev-review ${role} submit 不应输出 review-pack.mjs：${subCli.stdout}`
          }
        }

        const nx = JSON.parse(runLocal(dir, flowRel, ['next', '--task', taskId, '--json']).stdout)
        if (hasReviewKit) {
          if (nx.phase !== 'needs-review') return `full-kit ${role} 应进入 needs-review，实际=${nx.phase}`
          const mUnreviewed = useMockApi
            ? await handleMerge({ task: taskId, _ghClient: gh.client, _ghProbe: gh.ghProbe, ...(role === 'generic-git' ? { 'human-approved': true, reason: '远端是不可达的内网仓，已在别处人工核对合并结果' } : {}) }, roots)
            : await handleMerge({ task: taskId, ...(role === 'generic-git' ? { 'human-approved': true, reason: '远端是不可达的内网仓，已在别处人工核对合并结果' } : {}) }, roots)
          if (mUnreviewed.exitCode === 0) return `full-kit ${role} 未经独立审查 PASS 竟允许 merge 放行`

          const tok = await issueTokenFor(dir, taskId, 1)
          const rec = await handleRecord({
            task: taskId, round: '1', verdict: 'pass', 'reviewer-id': 'rev-bob', 'review-token': tok,
            evidence: '矩阵实测：测试全绿，输出符合预期',
            ...(useMockApi ? { _ghClient: gh.client, _ghProbe: gh.ghProbe } : {}),
          }, roots)
          if (rec !== 0) return `full-kit ${role} review record 失败：${rec}`
        } else {
          const expectedPhase = role === 'contributor-fork' ? 'awaiting-upstream-merge' : (role === 'generic-git' ? 'awaiting-remote-mr' : 'ready-to-merge')
          if (nx.phase !== expectedPhase) return `no-dev-review ${role} 应进入 ${expectedPhase}，实际=${nx.phase}`
        }
        if (role === 'contributor-fork') {
          const nxFork = hasReviewKit ? JSON.parse(runLocal(dir, flowRel, ['next', '--task', taskId, '--json']).stdout) : nx
          if (nxFork.phase !== 'awaiting-upstream-merge') return `${mode} contributor-fork 应进入 awaiting-upstream-merge，实际=${nxFork.phase}`
          const mBlockedFork = await handleMerge({ task: taskId, _ghClient: gh.client, _ghProbe: gh.ghProbe }, roots)
          if (mBlockedFork.exitCode === 0) return `${mode} contributor-fork 禁止自合却退出 0`
          continue
        }

        if (role === 'generic-git') {
          const mNeedFlag = await handleMerge({ task: taskId }, roots)
          if (mNeedFlag.exitCode === 0) return `${mode} generic-git 缺人类签字竟退出 0`
          const mGenOk = await handleMerge({ task: taskId, 'human-approved': true, reason: '远端是不可达的内网仓，已在别处人工核对合并结果' }, roots)
          if (mGenOk.exitCode !== 0) return `${mode} generic-git 人类签字后 merge 失败：${mGenOk.exitCode}`
        } else {
          const mOk = await handleMerge({ task: taskId, ...(useMockApi ? { _ghClient: gh.client, _ghProbe: gh.ghProbe } : {}) }, roots)
          if (mOk.exitCode !== 0) return `${mode} ${role} merge 失败：${mOk.exitCode}`
        }
      }
      return true
    } finally { cleanups.forEach(rmTree) }
  }

  cases.push(['C5/C6a：无 dev-review 高风险 6 类触发源合并门禁（缺确认退出 4，齐备放行）', async () => {
    const cleanups = []
    try {
      const hrTriggers = [
        ['highRiskHits', { file: 'src/core/key.mjs', content: 'export const k = 2\n' }, 2],
        ['gateWeakeningHits', { file: 'test/ok.test.mjs', content: 'import assert from "node:assert/strict"\n' }, 2],
        ['case>=4', { file: 'src/ok.mjs', content: 'export const ok = 2\n' }, 4],
        ['visual', { file: 'src/App.tsx', content: 'export const App = () => null\n' }, 2],
        ['oneWay', { file: 'package.json', content: JSON.stringify({ name: 'mx-hr', version: '1.0.1', scripts: { test: 'node test/ok.test.mjs' } }) + '\n' }, 2],
        ['doNotEdit', { file: 'docs/frozen/lock.md', content: '# changed\n' }, 2],
      ]
      for (const [label, change, caseType] of hrTriggers) {
        const { dir, bares } = setupMatrixRepo('norev', 'local-only', { caseType })
        cleanups.push(dir, ...bares)
        equip(dir, { noBackup: true })
        rmTree(join(dir, '.agents', 'skills', 'dev-review'))
        gitCommitFast(dir, 'equip without dev-review')
        const taskId = `hr-${label.toLowerCase().replace(/[^a-z0-9]/g, '')}`
        const roots = await resolveRepoRoots(dir)
        const s = await handleStart({
          task: taskId,
          case: String(caseType),
          slug: taskId,
          implementer: 'alice',
          ...(caseType >= 4
            ? { spec: 'docs/specs/261118-issue88-mx-spec.md', todo: 'docs/todo/261118-issue88-mx-todo.md' }
            : { 'no-issue': true, reason: '回归夹具聚焦高风险门禁触发源' }),
        }, roots)
        if (s.exitCode !== 0) return `no-dev-review high-risk(${label}) start 失败：${s.exitCode}`
        const ex = await handleExplore({ task: taskId }, roots)
        if (ex.exitCode !== 0) return `no-dev-review high-risk(${label}) explore 失败：${ex.exitCode}`
        const implAbs = join(dir, '.worktrees', `impl-${taskId}`)
        mkdirSync(dirname(join(implAbs, change.file)), { recursive: true })
        writeFileSync(join(implAbs, change.file), change.content, 'utf8')
        gitSync(implAbs, ['add', '-A'])
        gitSync(implAbs, ['commit', '-qm', `change ${label}`])
        if (caseType >= 4) {
          for (const docRel of ['docs/specs/261118-issue88-mx-spec.md', 'docs/todo/261118-issue88-mx-todo.md']) {
            const docAbs = join(implAbs, docRel)
            writeFileSync(docAbs, readFileSync(docAbs, 'utf8').replace('- [ ] C1:', '- [x] C1:'), 'utf8')
          }
          gitSync(implAbs, ['add', '-A'])
          gitSync(implAbs, ['commit', '-qm', 'check off C1'])
          const fin = await handleFinalize({ task: taskId }, roots)
          if (fin.exitCode !== 0) return `finalize(${label}) 失败：${fin.exitCode}`
          gitSync(implAbs, ['add', '-A'])
          gitSync(implAbs, ['commit', '-qm', `finalize ${label}`])
        }
        // 触及界面资源的变更要先过实证前置校验：这条用例跑在无渲染环境的临时仓里，
        // 按规矩就得如实报阻，不能靠裸布尔开关冒充「我看过了」。
        //
        // 这里顺手把它变成自证伪：不带报阻说明时必须被拦下，带上才放行。否则
        // 一旦前置校验哪天不生效了，这条用例会一声不响地永远绿着。
        const visualBlocked = { 'visual-blocked-reason': '临时仓无浏览器与渲染环境，无法观察界面' }
        if (label === 'visual') {
          const bareVer = await handleVerify({ task: taskId, mode: 'gate' }, roots)
          if (bareVer.exitCode === 0) {
            return `verify(${label}) 无任何界面实证却放行了——实证前置校验没生效`
          }
        }
        const ver = await handleVerify({ task: taskId, mode: 'gate', ...(label === 'visual' ? visualBlocked : {}) }, roots)
        if (label === 'doNotEdit') {
          if (ver.exitCode !== 3) return `doNotEdit 在 verify 阶段未硬阻断：exit=${ver.exitCode}`
          continue
        }
        if (ver.exitCode !== 0) return `verify(${label}) 失败：${ver.exitCode}`
        const sub = await handleSubmit({ task: taskId, agent: 'alice' }, roots)
        if (sub.exitCode !== 0) return `submit(${label}) 失败：${sub.exitCode}`

        const nx = await handleNext({ task: taskId, json: true }, roots)
        if (nx.exitCode !== 0) return `next(${label}) 失败`

        const mNoApprove = await handleMerge({ task: taskId }, roots)
        if (label === 'visual') {
          if (mNoApprove.exitCode !== 0) return `no-dev-review visual 已与 high 解耦（独立视觉轴），已过视觉实证不应误触发退出码 4：exit=${mNoApprove.exitCode}`
          continue
        }
        if (mNoApprove.exitCode !== 4) return `no-dev-review ${label} 无 --human-approved 未返回退出码 4：exit=${mNoApprove.exitCode}`
        const mNoReason = await handleMerge({ task: taskId, 'human-approved': true }, roots)
        if (mNoReason.exitCode !== 4) return `no-dev-review ${label} 缺 --reason 未返回退出码 4：exit=${mNoReason.exitCode}`
        const mOk = await handleMerge({ task: taskId, 'human-approved': true, reason: 'human verified risk' }, roots)
        if (mOk.exitCode !== 0) return `no-dev-review ${label} 附 --human-approved --reason 未放行：exit=${mOk.exitCode}`
      }
      return true
    } finally { cleanups.forEach(rmTree) }
  }, 71000])

  cases.push(['C5/C6b：无 dev-review × 5 角色兼容性矩阵', () => runRoleMatrixForMode('no-dev-review'), 71000])

  cases.push(['C5/C6c：有无 dev-review 合并门禁（完整套件 × 5 角色兼容性矩阵）', () => runRoleMatrixForMode('full-kit'), 71000])

  cases.push(['C9：5 类典型项目形态端到端接管、backup 还原、handoff 与内置 dev-flow 实测', async () => {
    const makePkgShape = (name, readme, extraFiles, scripts, testCmd) => ({
      name,
      runNativeTest: testCmd,
      files: {
        '.gitignore': '.worktrees/\n',
        'package.json': JSON.stringify({ name, version: '0.1.0', scripts }),
        'README.md': `# ${name}\n\n${readme}\n`,
        'test/ok.test.mjs': 'import assert from "node:assert/strict"\nassert.equal(1, 1)\n',
        ...extraFiles,
      },
    })
    const shapes = [
      makePkgShape('frontend', '前端应用示例项目，提供页面渲染与组件测试入口，验证项目接管全流程。',
        { 'pnpm-lock.yaml': 'lockfileVersion: 9.0\n', 'src/App.mjs': 'export const r = () => 1\n' },
        { test: 'node test/ok.test.mjs', build: 'node -e "0"' }, ['node', 'test/ok.test.mjs']),
      makePkgShape('backend', '后端服务示例项目，提供 HTTP 入口与服务状态校验测试，验证项目接管全流程。',
        { 'package-lock.json': '{}', 'src/server.mjs': 'export const port = 3000\n' },
        { test: 'node test/ok.test.mjs', check: 'node test/ok.test.mjs' }, ['node', 'test/ok.test.mjs']),
      makePkgShape('pure-lib', '纯工具库示例项目，对外提供无副作用数学辅助函数并附带单元测试。',
        { 'package-lock.json': '{}', 'src/index.mjs': 'export const add = (a, b) => a + b\n' },
        { test: 'node test/ok.test.mjs' }, ['node', 'test/ok.test.mjs']),
      {
        name: 'pure-docs',
        runNativeTest: null,
        files: {
          '.gitignore': '.worktrees/\n',
          'README.md': '# docs-hub\n\n纯文档知识库示例说明项目，仅维护架构说明与使用指南文档。\n',
          'guide/intro.md': '# Intro\n\n简介内容。\n',
        },
      },
      makePkgShape('ci-enabled', '带 CI 流水线项目示例，通过 GitHub Actions 工作流运行测试与检查。',
        { 'package-lock.json': '{}', '.github/workflows/ci.yml': 'name: CI\non: [push, pull_request]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n', 'src/main.mjs': 'export const v = 1\n' },
        { test: 'node test/ok.test.mjs', check: 'node test/ok.test.mjs' }, ['node', 'test/ok.test.mjs']),
    ]

    for (const shape of shapes) {
      const dir = tmpProject(shape.files)
      gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@acme-fixture.dev' })
      try {
        const sv = await runNode('survey.mjs', [dir, '--json'])
        if (sv.status !== 0) return `${shape.name} survey 失败：${sv.stderr}`
        const eq = await runNode('equip.mjs', [dir, '--no-backup'])
        if (eq.status !== 0) return `${shape.name} equip 失败：${eq.stderr}`
        const eqChk = await runNode('equip.mjs', [dir, '--check'])
        if (eqChk.status !== 0) return `${shape.name} equip --check 失败：${eqChk.stdout}${eqChk.stderr}`
        const comp = await runNode('compose-agents.mjs', [dir, '--no-backup'])
        if (comp.status !== 0) return `${shape.name} compose-agents 失败：${comp.stderr}`

        // 校准占位与取舍
        const testCmd = shape.name === 'pure-docs' ? 'none' : (shape.name === 'frontend' ? 'pnpm test' : 'npm test')
        const highRisk = shape.name === 'pure-docs' ? 'AGENTS.md' : 'src/'
        const rawAgents = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
        writeFileSync(join(dir, 'AGENTS.md'), calibrateAgentsText(rawAgents, testCmd, highRisk), 'utf8')

        const chk = await runNode('compose-agents.mjs', [dir, '--check'])
        if (chk.status !== 0) return `${shape.name} compose --check 失败：${chk.stdout}${chk.stderr}`
        const rev = await runNode('review.mjs', [dir])
        if (rev.status !== 0) return `${shape.name} review.mjs 未退出 0：status=${rev.status} out=${rev.stdout}`

        // backup create -> mutate -> restore 校验
        const bkC = await runNode('backup.mjs', ['create', dir, '--label', 'shape-bk'])
        if (bkC.status !== 0) return `${shape.name} backup create 失败：${bkC.stderr}`
        const beforeRestore = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
        writeFileSync(join(dir, 'AGENTS.md'), '# CORRUPTED\n', 'utf8')
        const bkR = await runNode('backup.mjs', ['restore', dir])
        if (bkR.status !== 0 || readFileSync(join(dir, 'AGENTS.md'), 'utf8') !== beforeRestore) {
          return `${shape.name} backup restore 未还原 AGENTS.md：status=${bkR.status}`
        }

        // compose --clean 后 handoff --scan 必须干净，且项目自身测试与独立 dev-flow 正常执行
        const clean = await runNode('compose-agents.mjs', [dir, '--clean', '--no-backup'])
        if (clean.status !== 0) return `${shape.name} compose --clean 失败：${clean.stderr}`
        const hScan = handoffScan(dir)
        if (!hScan.clean) return `${shape.name} 剥离后 handoff --scan 不干净：${JSON.stringify({ markers: hScan.markers, placeholders: hScan.placeholders, dangling: hScan.danglingPointers })}`

        if (shape.runNativeTest) {
          const nt = spawnSync(shape.runNativeTest[0], shape.runNativeTest.slice(1), { cwd: dir, encoding: 'utf8' })
          if (nt.status !== 0) return `${shape.name} 自身测试失败：${nt.stderr}`
        }
        const localFlow = runLocal(dir, '.agents/skills/dev-flow/scripts/flow.mjs', ['inspect', '--json'])
        if (localFlow.status !== 0) return `${shape.name} 独立 dev-flow 执行失败：${localFlow.stderr}`
      } finally { rmTree(dir) }
    }
    if (!existsSync(join(SKILL_ROOT, '.agents', 'skills'))) return 'SKILL_ROOT 校验异常'
    return true
  }])
}
