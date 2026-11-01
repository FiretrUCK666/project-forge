/**
 * task-runners.mjs —— 通用任务入口的命令推导。
 *
 * 这类工具的共同形状是「仓库里有一个声明任务的文件，工具按名字跑任务」：
 * Makefile、justfile、Taskfile、deno tasks，以及 Gradle / Maven / .NET / CMake / Go
 * 那几套「约定胜过配置」的构建系统。它们的项目往往没有语言清单，或者清单里不写命令，
 * 所以「怎么构建」只能从这些文件里读。
 *
 * 从 survey.mjs 拆出来，是因为它是**独立的一个维度**：输入是文件系统，输出是命令表，
 * 与生态判定、文档盘点、git 事实没有共享状态。原先夹在勘察引擎中间，改一种工具的
 * 解析要在三千行里找。
 *
 * 判据一律是「找到那个文件 → 读它 → 认出里面有哪些任务」，认不出就返回空，
 * 不猜工具名也不猜任务名。
 */

import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { readTextFile } from './text.mjs'

/**
 * 从**任务入口文件**推导命令。与按生态推导正交，两者都要跑。
 *
 * 为什么单独一段：一个 Python 项目可以用 Makefile 组织测试，一个 C++ 项目可能只有
 * CMakeLists.txt，一个 polyglot 仓库常常只靠 justfile 串起来。只看生态会漏掉整类
 * 项目——它们的构建命令写在入口文件里，不在生态惯例里。
 *
 * 两条纪律：
 *   - **只读文件里真实存在的目标**。Makefile 里没有 test 目标就报没有，不按惯例编一个
 *     make test——那会造出一条跑不通的「硬门禁」，而 P7 的「没有验证过」这个诚实信号
 *     再也出现不了。
 *   - **读不懂就说读不懂**。JSON 解析不了、文件读不出来时给一条 note 说明原因，
 *     而不是静默返回空——空的意思是「这个项目没有入口」，那是另一回事。
 */
export function taskRunnerCommands(root, root_) {
  const build = {}
  const byTool = {}
  let sawAny = false

  const readIf = (name) => {
    const real = root_.real(name)
    if (real === undefined) return undefined
    try {
      return readFileSync(join(root, real), 'utf8')
    } catch {
      return undefined
    }
  }

  /** 从一组目标名里挑出常规命令键；一条都没有时给 note 并带上真实目标名。 */
  const pickTargets = (names, make, label, file) => {
    const got = {}
    for (const [key, aliases] of [
      ['build', ['build', 'all']], ['test', ['test', 'check']],
      ['lint', ['lint']], ['verify', ['verify']], ['install', ['install']],
    ]) {
      const hit = aliases.find((a) => names.has(a))
      if (hit !== undefined) got[key] = make(hit)
    }
    if (Object.keys(got).length > 0) return got
    const shown = [...names].filter((t) => !t.startsWith('.')).slice(0, 8)
    return {
      note: `有 ${file}，但没有 build / test 一类目标：`
        + `已定义的是 ${shown.length > 0 ? shown.join('、') : '（空）'}——请读它确认该跑哪一条`,
    }
  }

  /** Makefile：从目标名推导。 */
  const makefile = root_.first(['Makefile', 'makefile', 'GNUmakefile'])
  if (makefile !== undefined) {
    const text = readIf(makefile)
    if (text === undefined) {
      byTool.make = { note: `有 ${makefile} 但读不出来，命令要打开它确认` }
    } else {
      const targets = new Set()
      for (const line of text.split(/\r?\n/)) {
        if (/^\s/.test(line)) continue
        const m = /^([A-Za-z0-9_.-]+)\s*:(?!=)/.exec(line)
        if (m !== null) targets.add(m[1])
      }
      byTool.make = pickTargets(targets, (t) => `make ${t}`, 'make', makefile)
      if (byTool.make.note === undefined) sawAny = true
    }
  }

  /** justfile：recipe 名在行首，可带参数与依赖。 */
  const justfile = root_.first(['justfile', 'Justfile', '.justfile'])
  if (justfile !== undefined) {
    const text = readIf(justfile)
    if (text === undefined) {
      byTool.just = { note: `有 ${justfile} 但读不出来，命令要打开它确认` }
    } else {
      const recipes = new Set()
      for (const line of text.split(/\r?\n/)) {
        if (/^\s/.test(line) || line.startsWith('#')) continue
        const m = /^@?([A-Za-z0-9_-]+)(?:\s+[^:]*)?\s*:/.exec(line)
        if (m !== null) recipes.add(m[1])
      }
      byTool.just = pickTargets(recipes, (t) => `just ${t}`, 'just', justfile)
      if (byTool.just.note === undefined) sawAny = true
    }
  }

  /** Taskfile：只认 tasks: 之下、比 tasks 行多缩进一级的键。 */
  const taskfile = root_.first(['Taskfile.yml', 'Taskfile.yaml', 'taskfile.yml', 'taskfile.yaml'])
  if (taskfile !== undefined) {
    const text = readIf(taskfile)
    if (text === undefined) {
      byTool.task = { note: `有 ${taskfile} 但读不出来，命令要打开它确认` }
    } else {
      const tasks = new Set()
      let inTasks = false
      let taskIndent = -1
      for (const line of text.split(/\r?\n/)) {
        if (/^\s*(?:#|$)/.test(line)) continue
        const indent = line.length - line.trimStart().length
        if (/^\s*tasks\s*:/.test(line)) { inTasks = true; taskIndent = -1; continue }
        if (!inTasks) continue
        if (indent === 0) { inTasks = false; continue }
        if (taskIndent < 0) taskIndent = indent
        if (indent !== taskIndent) continue
        const m = /^\s+([A-Za-z0-9_:.-]+)\s*:/.exec(line)
        if (m !== null) tasks.add(m[1])
      }
      byTool.task = pickTargets(tasks, (t) => `task ${t}`, 'task', taskfile)
      if (byTool.task.note === undefined) sawAny = true
    }
  }

  /** deno.json：tasks 是 JSON 对象；jsonc 去注释与尾逗号后再解析。 */
  const denoName = root_.first(['deno.json', 'deno.jsonc'])
  if (denoName !== undefined) {
    const text = readIf(denoName)
    if (text === undefined) {
      byTool.deno = { note: `有 ${denoName} 但读不出来，命令要打开它确认` }
    } else {
      let tasks
      let parsed = true
      try {
        const stripped = text.replace(/^\s*\/\/.*$/gm, '').replace(/,([\s}\]])/g, '$1')
        tasks = JSON.parse(stripped)?.tasks
      } catch {
        parsed = false
      }
      if (!parsed) {
        byTool.deno = { note: `${denoName} 解析不了（不是合法 JSON），命令要打开它确认` }
      } else if (tasks !== undefined && typeof tasks === 'object' && tasks !== null) {
        const names = new Set(Object.keys(tasks).filter((k) => typeof tasks[k] === 'string'))
        byTool.deno = pickTargets(names, (t) => `deno task ${t}`, 'deno', denoName)
        if (byTool.deno.note === undefined) sawAny = true
      } else {
        byTool.deno = { note: `${denoName} 里没有 tasks 字段` }
      }
    }
  }

  /** Gradle：有包装器就用包装器，没有就用 PATH 里的 gradle。 */
  const gradlew = root_.first(['gradlew', 'gradlew.bat'])
  const gradleBuild = root_.first(['build.gradle', 'build.gradle.kts'])
  if (gradlew !== undefined || gradleBuild !== undefined) {
    const prefix = gradlew === undefined ? 'gradle' : (gradlew.endsWith('.bat') ? '.\\gradlew.bat' : './gradlew')
    byTool.gradle = { build: `${prefix} build`, test: `${prefix} test` }
    sawAny = true
  }

  /** Maven：同上。 */
  const mvnw = root_.first(['mvnw', 'mvnw.cmd'])
  const pom = root_.first(['pom.xml'])
  if (mvnw !== undefined || pom !== undefined) {
    const prefix = mvnw === undefined ? 'mvn' : (mvnw.endsWith('.cmd') ? '.\\mvnw.cmd' : './mvnw')
    byTool.maven = { build: `${prefix} -B package`, test: `${prefix} -B test` }
    sawAny = true
  }

  /** .NET：解决方案或单个项目文件，dotnet test 对两者都成立。 */
  const dotnetProj = root_.filesIn('', /\.(sln|csproj|fsproj|vbproj)$/i)
  if (dotnetProj.length > 0) {
    byTool.dotnet = { build: 'dotnet build', test: 'dotnet test' }
    sawAny = true
  }

  /** CMake：配置与构建两步；测试只在开了 CTest 惯例时给。 */
  const cmakeLists = root_.first(['CMakeLists.txt'])
  if (cmakeLists !== undefined) {
    const text = readIf(cmakeLists) ?? ''
    const got = { install: 'cmake -S . -B build', build: 'cmake --build build' }
    if (/enable_testing\s*\(|include\s*\(\s*CTest/i.test(text)) got.test = 'ctest --test-dir build'
    byTool.cmake = got
    sawAny = true
  }

  /** Go workspace：命令要覆盖全部模块，而不是只覆盖根目录那一个。 */
  if (root_.has('go.work')) {
    byTool.goWorkspace = { build: 'go build ./...', test: 'go test ./...' }
    sawAny = true
  }

  if (!sawAny && Object.keys(byTool).length === 0) return undefined

  // 各工具的命令并进一张扁平表：真冲突时先到者为准，byTool 让人看得到每条出自哪个文件。
  for (const got of Object.values(byTool)) {
    for (const [k, v] of Object.entries(got)) {
      if (k !== 'note' && typeof v === 'string' && !(k in build)) build[k] = v
    }
  }
  if (Object.keys(build).length > 0) {
    build.byTool = byTool
  } else {
    build.note = `有任务入口文件（${Object.keys(byTool).join('、')}），但没有推导出命令——请读它们确认`
  }
  return build
}
