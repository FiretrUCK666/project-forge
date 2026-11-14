/**
 * starter-templates.mjs —— 空白工程六栈起步骨架与标准化初始 TDD 生成器。
 *
 * - 支持 `node | python | go | rust | java | docs`，零第三方依赖。
 * - `starterTdd` 包含 `## 文档信息` 元信息表、矩形 <= 16 / 菱形 <= 12 零 HTML Mermaid 图、
 *   `arch-rules: none` 与可验证 `Feature Map`。
 * - `bootstrapEmpty` 自动补齐 `docs/{prd,specs,todo}/.gitkeep`，并过滤 macOS 元数据。
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { writeAtomic } from './fs-atomic.mjs'
import { isMacOsMetadata } from './protocol.mjs'

export const BOOTSTRAP_LANGS = new Set(['node', 'python', 'go', 'rust', 'java', 'docs'])

const EMPTY_NOISE_ENTRIES = new Set([
  '.git', '.DS_Store', 'Thumbs.db', 'desktop.ini', '.gitkeep', '.vscode', '.idea', '.agents',
])

function isNearlyEmptyDir(root) {
  if (!existsSync(root)) return { empty: true, blocking: [] }
  const blocking = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (EMPTY_NOISE_ENTRIES.has(entry.name) || isMacOsMetadata(entry.name)) continue
    blocking.push(entry.name)
  }
  return { empty: blocking.length === 0, blocking }
}

function sanitizeNames(rawName, targetDir) {
  const base = (rawName || basename(resolve(targetDir)) || 'starter-app').trim()
  const kebab = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'starter-app'
  const ident = kebab.replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'starter_app'
  const safeIdent = /^[0-9]/.test(ident) ? `app_${ident}` : ident
  return { display: base, kebab, ident: safeIdent }
}

function localIsoDate(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const BASE_GITATTRIBUTES = [
  '# 统一文本行尾与常见二进制规则（需在首次提交前就位）',
  '* text=auto eol=lf',
  '',
  '*.bat text eol=crlf',
  '*.cmd text eol=crlf',
  '*.ps1 text eol=crlf',
  '',
  '*.png binary',
  '*.jpg binary',
  '*.jpeg binary',
  '*.gif binary',
  '*.ico binary',
  '*.webp binary',
  '*.pdf binary',
  '*.zip binary',
  '*.gz binary',
  '*.tgz binary',
  '*.7z binary',
  '*.woff binary',
  '*.woff2 binary',
  '*.ttf binary',
  '',
].join('\n')

const BASE_GITIGNORE = [
  '# Worktree、系统杂项与本地环境变量',
  '.worktrees/',
  '.DS_Store',
  '._*',
  'Thumbs.db',
  'desktop.ini',
  '.env',
  '.env.*',
  '!.env.example',
  '*.log',
  'tmp/',
  '.cache/',
]

function buildGitignore(langEntries = []) {
  return [...BASE_GITIGNORE, '', ...langEntries, ''].join('\n')
}

function starterReadme({ names, summary, quickstartLines, treeLines }) {
  return [
    `# ${names.display}`,
    '',
    summary,
    '',
    '## 快速开始',
    '',
    '```sh',
    ...quickstartLines,
    '```',
    '',
    '## 目录结构',
    '',
    ...treeLines,
    '',
    '## 工程与协作说明',
    '',
    '- 架构与模块边界见 [docs/TDD.md](docs/TDD.md)。',
    '- 若项目已生成 `AGENTS.md`，日常研发契约与验证命令以它为准。',
    '',
  ].join('\n')
}

function starterTdd({
  names, summary, treeLines, featureName, entryFile, testCmd,
  lang, runtimeStack, flowKind = 'code', today = localIsoDate(),
}) {
  const diagram = flowKind === 'docs'
    ? [
        '```mermaid',
        'flowchart TB',
        '  In["文档入口"] --> Core["内容指南"]',
        '  Core --> Gate{"链接核对"}',
        '  Gate -- "通过" --> Out["可交付"]',
        '```',
      ]
    : [
        '```mermaid',
        'flowchart TB',
        '  In["入口模块"] --> Core["核心逻辑"]',
        '  Core --> Gate{"自检验证"}',
        '  Gate -- "通过" --> Out["输出结果"]',
        '```',
      ]

  return [
    `# ${names.display} 技术设计说明（TDD）`,
    '',
    '## 文档信息',
    '',
    '| 项目 | 内容 |',
    '| --- | --- |',
    '| 文档版本 | `0.1.0` |',
    `| 编制日期 | \`${today}\` |`,
    `| 最近更新日期 | \`${today}\` |`,
    `| 基线依据 | \`--bootstrap-empty --lang ${lang}\` 起步骨架 |`,
    `| 运行环境与生态栈 | ${runtimeStack} |`,
    '| 托管平台适配范围 | GitHub（本地无远端同样完整运行） |',
    '| 关联工程契约 | `AGENTS.md`（若已装配） |',
    '',
    '## 目标与边界',
    '',
    `- ${summary}`,
    '- 在此补充核心模块边界、对外接口与关键不变量。',
    '',
    '## 系统拓扑',
    '',
    ...diagram,
    '',
    '## 目录结构',
    '',
    ...treeLines,
    '',
    '## 模块分层与禁引规则（arch-rules）',
    '',
    '<!-- 无明显跨层禁引时 AGENTS.md 中 arch-rules 保持 none；拆出分层后再在此补充单向依赖约束 -->',
    '- 当前为单层起步结构，暂无跨层禁引规则（`arch-rules: none`）。',
    '',
    '## 功能与入口地图（Feature Map）',
    '',
    '| 功能 / 能力 | 入口文件或符号 | 验证命令 |',
    '| --- | --- | --- |',
    `| ${featureName} | \`${entryFile}\` | \`${testCmd}\` |`,
    '',
  ].join('\n')
}

export function starterTemplates(lang, rawName, description = '') {
  const names = sanitizeNames(rawName, process.cwd())
  const summary = String(description ?? '').trim() || `${names.display} 最小可运行工程骨架。`

  const gitBase = (extraIgnore) => ({
    '.gitattributes': BASE_GITATTRIBUTES,
    '.gitignore': buildGitignore(extraIgnore),
  })

  if (lang === 'node') {
    const treeLines = [
      '- `src/index.mjs`：核心入口模块',
      '- `test/smoke.test.mjs`：内置 `node --test` 冒烟测试',
      '- `docs/TDD.md`：技术设计文档与 Feature Map',
    ]
    return {
      ...gitBase(['node_modules/', '.pnpm-store/', 'dist/', 'build/', 'coverage/']),
      'package.json': `${JSON.stringify({
        name: names.kebab,
        version: '0.1.0',
        description: summary,
        private: true,
        type: 'module',
        scripts: {
          start: 'node src/index.mjs',
          test: 'node --test',
        },
        engines: { node: '>=18' },
      }, null, 2)}\n`,
      'src/index.mjs': [
        "import { pathToFileURL } from 'node:url'",
        '',
        "export function greet(name = 'world') {",
        "  const clean = String(name ?? '').trim() || 'world'",
        '  return `hello, ${clean}`',
        '}',
        '',
        'if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {',
        '  process.stdout.write(`${greet(process.argv[2])}\\n`)',
        '}',
        '',
      ].join('\n'),
      'test/smoke.test.mjs': [
        "import test from 'node:test'",
        "import assert from 'node:assert/strict'",
        "import { greet } from '../src/index.mjs'",
        '',
        "test('greet returns default and named greetings', () => {",
        "  assert.equal(greet(), 'hello, world')",
        "  assert.equal(greet('forge'), 'hello, forge')",
        '})',
        '',
      ].join('\n'),
      'README.md': starterReadme({
        names,
        summary,
        quickstartLines: ['npm test', 'npm start'],
        treeLines,
      }),
      'docs/TDD.md': starterTdd({
        names,
        summary,
        treeLines,
        lang: 'node',
        runtimeStack: 'Node.js 18+（ESM，零第三方依赖）',
        featureName: '基础问候与 CLI 入口（`greet`）',
        entryFile: 'src/index.mjs',
        testCmd: 'npm test',
      }),
    }
  }

  if (lang === 'python') {
    const pkgEntry = `src/${names.ident}/__init__.py`
    const treeLines = [
      `- \`${pkgEntry}\`：Python 包核心入口`,
      '- `tests/test_smoke.py`：标准库 `unittest` 冒烟测试',
      '- `docs/TDD.md`：技术设计文档与 Feature Map',
    ]
    return {
      ...gitBase([
        '__pycache__/', '*.py[cod]', '.venv/', 'venv/',
        '.pytest_cache/', '.mypy_cache/', '.ruff_cache/', 'dist/', 'build/', '*.egg-info/',
      ]),
      'pyproject.toml': [
        '[build-system]',
        'requires = ["setuptools>=68"]',
        'build-backend = "setuptools.build_meta"',
        '',
        '[project]',
        `name = "${names.kebab}"`,
        'version = "0.1.0"',
        `description = ${JSON.stringify(summary)}`,
        'requires-python = ">=3.10"',
        'dependencies = []',
        '',
      ].join('\n'),
      [pkgEntry]: [
        'def greet(name: str = "world") -> str:',
        '    clean = (name or "").strip() or "world"',
        '    return f"hello, {clean}"',
        '',
      ].join('\n'),
      'tests/test_smoke.py': [
        'from pathlib import Path',
        'import sys',
        'import unittest',
        '',
        'sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))',
        '',
        `from ${names.ident} import greet`,
        '',
        '',
        'class SmokeTest(unittest.TestCase):',
        '    def test_greet(self) -> None:',
        '        self.assertEqual(greet(), "hello, world")',
        '        self.assertEqual(greet("forge"), "hello, forge")',
        '',
        '',
        'if __name__ == "__main__":',
        '    unittest.main()',
        '',
      ].join('\n'),
      'README.md': starterReadme({
        names,
        summary,
        quickstartLines: ['python3 -m unittest discover -s tests'],
        treeLines,
      }),
      'docs/TDD.md': starterTdd({
        names,
        summary,
        treeLines,
        lang: 'python',
        runtimeStack: 'Python >=3.10（标准库，零第三方依赖）',
        featureName: '基础问候接口（`greet`）',
        entryFile: pkgEntry,
        testCmd: 'python3 -m unittest discover -s tests',
      }),
    }
  }

  if (lang === 'go') {
    const treeLines = [
      '- `hello.go`：核心包入口函数',
      '- `hello_test.go`：标准库 `testing` 冒烟测试',
      '- `docs/TDD.md`：技术设计文档与 Feature Map',
    ]
    return {
      ...gitBase(['bin/', 'dist/', 'coverage.out', '*.exe']),
      'go.mod': `module example.com/${names.kebab}\n\ngo 1.21\n`,
      'hello.go': [
        'package hello',
        '',
        'import "strings"',
        '',
        'func Greet(name string) string {',
        '\tclean := strings.TrimSpace(name)',
        '\tif clean == "" {',
        '\t\tclean = "world"',
        '\t}',
        '\treturn "hello, " + clean',
        '}',
        '',
      ].join('\n'),
      'hello_test.go': [
        'package hello',
        '',
        'import "testing"',
        '',
        'func TestGreet(t *testing.T) {',
        '\tif got := Greet(""); got != "hello, world" {',
        '\t\tt.Fatalf("unexpected default greeting: %q", got)',
        '\t}',
        '\tif got := Greet("forge"); got != "hello, forge" {',
        '\t\tt.Fatalf("unexpected named greeting: %q", got)',
        '\t}',
        '}',
        '',
      ].join('\n'),
      'README.md': starterReadme({
        names,
        summary,
        quickstartLines: ['go test ./...'],
        treeLines,
      }),
      'docs/TDD.md': starterTdd({
        names,
        summary,
        treeLines,
        lang: 'go',
        runtimeStack: 'Go 1.21+（标准库，零第三方依赖）',
        featureName: '基础问候接口（`Greet`）',
        entryFile: 'hello.go',
        testCmd: 'go test ./...',
      }),
    }
  }

  if (lang === 'rust') {
    const treeLines = [
      '- `src/lib.rs`：核心库入口与内联单元测试',
      '- `docs/TDD.md`：技术设计文档与 Feature Map',
    ]
    return {
      ...gitBase(['target/']),
      'Cargo.toml': [
        '[package]',
        `name = "${names.ident}"`,
        'version = "0.1.0"',
        'edition = "2021"',
        '',
        '[dependencies]',
        '',
      ].join('\n'),
      'src/lib.rs': [
        'pub fn greet(name: &str) -> String {',
        '    let clean = name.trim();',
        '    let target = if clean.is_empty() { "world" } else { clean };',
        '    format!("hello, {}", target)',
        '}',
        '',
        '#[cfg(test)]',
        'mod tests {',
        '    use super::*;',
        '',
        '    #[test]',
        '    fn smoke_test() {',
        '        assert_eq!(greet(""), "hello, world");',
        '        assert_eq!(greet("forge"), "hello, forge");',
        '    }',
        '}',
        '',
      ].join('\n'),
      'README.md': starterReadme({
        names,
        summary,
        quickstartLines: ['cargo test'],
        treeLines,
      }),
      'docs/TDD.md': starterTdd({
        names,
        summary,
        treeLines,
        lang: 'rust',
        runtimeStack: 'Rust 2021 Edition（标准库，零第三方依赖）',
        featureName: '基础问候接口（`greet`）',
        entryFile: 'src/lib.rs',
        testCmd: 'cargo test',
      }),
    }
  }

  if (lang === 'java') {
    const entryFile = 'src/main/java/app/Greeter.java'
    const testFile = 'src/test/java/app/SmokeTest.java'
    const compileAndTest = `javac -d out ${entryFile} ${testFile} && java -ea -cp out app.SmokeTest`
    const treeLines = [
      `- \`${entryFile}\`：Java 标准库核心入口类`,
      `- \`${testFile}\`：无外部 jar 依赖的 \`-ea\` 断言冒烟测试`,
      '- `docs/TDD.md`：技术设计文档与 Feature Map',
    ]
    return {
      ...gitBase(['out/', 'target/', 'build/', '*.class', '*.jar', '.gradle/']),
      [entryFile]: [
        'package app;',
        '',
        'public final class Greeter {',
        '  private Greeter() {}',
        '',
        '  public static String greet(String name) {',
        '    String clean = name == null ? "" : name.trim();',
        '    if (clean.isEmpty()) {',
        '      clean = "world";',
        '    }',
        '    return "hello, " + clean;',
        '  }',
        '',
        '  public static void main(String[] args) {',
        '    String arg = args.length > 0 ? args[0] : "";',
        '    System.out.println(greet(arg));',
        '  }',
        '}',
        '',
      ].join('\n'),
      [testFile]: [
        'package app;',
        '',
        'public final class SmokeTest {',
        '  private SmokeTest() {}',
        '',
        '  public static void main(String[] args) {',
        '    assert "hello, world".equals(Greeter.greet("")) : "expected default greeting";',
        '    assert "hello, forge".equals(Greeter.greet("forge")) : "expected named greeting";',
        '    System.out.println("SmokeTest passed.");',
        '  }',
        '}',
        '',
      ].join('\n'),
      'README.md': starterReadme({
        names,
        summary,
        quickstartLines: [
          `javac -d out ${entryFile} ${testFile}`,
          'java -ea -cp out app.SmokeTest',
          'java -cp out app.Greeter',
        ],
        treeLines,
      }),
      'docs/TDD.md': starterTdd({
        names,
        summary,
        treeLines,
        lang: 'java',
        runtimeStack: 'Java 17+（标准 JDK，零第三方依赖）',
        featureName: '基础问候与 CLI 入口（`Greeter.greet`）',
        entryFile,
        testCmd: compileAndTest,
      }),
    }
  }

  const docsSummary = String(description ?? '').trim() || '项目说明与结构化文档入口。'
  const docTree = [
    '- `README.md`：项目门面与阅读入口',
    '- `docs/guide.md`：结构化使用指南',
    '- `docs/TDD.md`：目录边界与维护约定',
  ]
  return {
    ...gitBase(['dist/', 'build/', '_site/']),
    'README.md': starterReadme({
      names,
      summary: docsSummary,
      quickstartLines: ['# 纯文档目录，按 docs/guide.md 与 README.md 导航阅读并核对链接有效性'],
      treeLines: docTree,
    }),
    'docs/guide.md': [
      `# ${names.display} 使用指南`,
      '',
      '在此编写结构化的面向读者文档。',
      '',
    ].join('\n'),
    'docs/TDD.md': starterTdd({
      names,
      summary: docsSummary,
      treeLines: docTree,
      lang: 'docs',
      runtimeStack: '纯文档项目（无编译或运行时依赖）',
      flowKind: 'docs',
      featureName: '项目总览与文档索引',
      entryFile: 'README.md',
      testCmd: '人工核对文档结构与相对链接可达性',
    }),
  }
}

/** 仅在空白（或仅含编辑区杂项）的目录生成最小可运行工程骨架、初始 `docs/TDD.md` 与文档目录占位。 */
export function bootstrapEmpty(targetDir, {
  lang,
  name,
  description = '',
  dryRun = false,
} = {}) {
  const root = resolve(targetDir)
  if (!BOOTSTRAP_LANGS.has(lang)) {
    throw new Error(`--lang 必须是 ${[...BOOTSTRAP_LANGS].join(' | ')} 之一（收到：${lang ?? '未指定'}）`)
  }
  const check = isNearlyEmptyDir(root)
  if (!check.empty) {
    throw new Error(`目标目录非空（已存在：${check.blocking.slice(0, 5).join('、')}），拒绝执行 --bootstrap-empty`)
  }

  const names = sanitizeNames(name, root)
  const files = {
    ...starterTemplates(lang, names.display, description),
    'docs/prd/.gitkeep': '',
    'docs/specs/.gitkeep': '',
    'docs/todo/.gitkeep': '',
  }
  const created = []
  const skipped = []

  for (const [rel, content] of Object.entries(files)) {
    const dest = join(root, rel)
    if (existsSync(dest)) {
      skipped.push(rel)
      continue
    }
    created.push(rel)
    if (!dryRun) {
      mkdirSync(dirname(dest), { recursive: true })
      writeAtomic(dest, String(content).replace(/\r\n/g, '\n'))
    }
  }

  return { target: root, lang, name: names.kebab, dryRun, created, ...(skipped.length > 0 ? { skipped } : {}) }
}
