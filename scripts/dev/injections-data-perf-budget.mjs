/**
 * injections-data-perf-budget.mjs —— Milestone C Wave 1A (`low-cpu-script-perf`) C1..C3 故障注入复验数据表（I1031-I1037）。
 */

export const INJECTIONS_PERF_BUDGET = [
  {
    id: 'I1031',
    what: 'C1 proc-budget: 破坏 resolveWorkerConcurrency 吃满全核不留前台余量',
    file: 'kit/skills/lib/proc-budget.mjs',
    alsoDropIn: ['.agents/skills/lib/proc-budget.mjs'],
    from: '  const budgeted = Math.max(1, totalCores - reserved)',
    to: '  const budgeted = Math.max(1, totalCores)',
    expect: '[PerfBudget-C1]',
  },
  {
    id: 'I1032',
    what: 'C1 proc-budget: 破坏 applyLowPriority 对异常未兜底导致非法/权限错误抛出中断主流程',
    file: 'kit/skills/lib/proc-budget.mjs',
    alsoDropIn: ['.agents/skills/lib/proc-budget.mjs'],
    from: '  } catch (err) {\n    return {',
    to: '  } catch (err) {\n    throw err\n    return {',
    expect: '[PerfBudget-C1]',
  },
  {
    id: 'I1033',
    what: 'C2 fixtures: 破坏 resolveOnlyCandidateFiles 丢弃跨文件反向 import 闭包',
    file: 'scripts/dev/fixtures.mjs',
    from: '    for (const next of [...(deps.get(cur) ?? []), ...(reverseDeps.get(cur) ?? [])]) {',
    to: '    for (const next of []) {',
    expect: '[PerfBudget-C2]',
  },
  {
    id: 'I1034',
    what: 'C2 fixtures: 破坏 --only 0 命中自动回退全量导入导致动态拼名用例漏跑',
    file: 'scripts/dev/fixtures.mjs',
    from: '    } else if (pre.files.length < DISCOVERED_FILES.length) {',
    to: '    } else if (false) {',
    expect: '[PerfBudget-C2]',
  },
  {
    id: 'I1035',
    what: 'C2 fixtures-helpers: 移除 mod.main 兼容导致 equip-ci 回退子进程',
    file: 'scripts/dev/fixtures-helpers.mjs',
    from: "    : (typeof mod?.main === 'function' ? mod.main : null)",
    to: '    : null',
    expect: '[PerfBudget-C2]',
  },
  {
    id: 'I1036',
    what: 'C2 preflight-e2e: 破坏 checkHelps 放行未输出「用法」的损坏脚本',
    file: 'scripts/dev/preflight-e2e.mjs',
    from: "    if (!/用法/.test(res.stdout || '')) fail(`${name} --help 没打印用法`)",
    to: "    if (false) fail(`${name} --help 没打印用法`)",
    expect: '[PerfBudget-C2]',
  },
  {
    id: 'I1037',
    what: 'C3 git-fast-objects: 破坏 readBlobBatch 返回空映射导致批量直读静默失真',
    file: 'kit/skills/lib/git-fast-objects.mjs',
    alsoDropIn: ['.agents/skills/lib/git-fast-objects.mjs'],
    from: '  if (!repoRoot || !rev || unique.length === 0) return result',
    to: '  if (repoRoot) return result',
    expect: '[PerfBudget-C3]',
  },
]
