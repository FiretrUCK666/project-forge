/**
 * injections-data-w6b.mjs —— Wave 6 Slice 6B 故障注入复验样本集（I435–I442）。
 *
 * 覆盖 C7..C12 + C19 核心不变量：
 *   I435 (C7):  SUBCOMMAND_META mutating 标记退化导致 doc-verify 放行变更型子命令
 *   I436 (C8):  doc-verify 退化不再按 COMMON_SKIP_DIRS 跳过 target/.venv 构建/虚拟环境目录
 *   I437 (C9):  preflight-suite scanKitPrivateLeaks 放行本仓私有符号泄漏
 *   I438 (C10): no-changelog-voice 在源码文件中退化为裸扫原始文本而非剥离字面量查注释
 *   I439 (C11): feature-map matchTestsForSourceFile 丢弃跨生态隔离
 *   I440 (C11): static-gates TEST_CASE_RE 丢弃前置词界约束误判 this.test(v)
 *   I441 (C19): isGeneratedSourceHeader 放宽 20 行头部窗口导致文件尾部注释绕过神文件检查
 *   I442 (C19): classifyDeclarativeDataFile 放行含控制流语句的混杂业务文件
 */

export const INJECTIONS_W6B = [
  {
    id: 'I435',
    what: 'C7 subcommand-meta: 将 flow intake 误标为只读导致 doc-verify 执行状态变更子命令',
    file: 'kit/skills/lib/subcommand-meta.mjs',
    alsoDropIn: ['.agents/skills/lib/subcommand-meta.mjs'],
    from: "      entry('intake', true),",
    to: "      entry('intake', false),",
    expect: 'W6B C7：SUBCOMMAND_META 单源、subcommand-parity 对拍与 doc-verify/triage-rules 消费',
  },
  {
    id: 'I436',
    what: 'C8 doc-verify: isSkippedScanPath 不再按 COMMON_SKIP_DIRS 跳过 target/.venv',
    file: 'kit/skills/lib/doc-verify.mjs',
    alsoDropIn: ['.agents/skills/lib/doc-verify.mjs'],
    from: '  return parts.slice(0, -1).some((seg) => COMMON_SKIP_DIRS.has(seg))',
    to: '  return false',
    expect: 'W6B C8：doc-verify COMMON_SKIP_DIRS、多语言 PATH_RE 与安全只读多生态命令核查',
  },
  {
    id: 'I437',
    what: 'C9 preflight-suite: scanKitPrivateLeaks 跳过私有符号正则检查',
    file: 'scripts/dev/preflight-suite.mjs',
    from: '      const m = KIT_PRIVATE_SYMBOL_RE.exec(lines[i])',
    to: '      const m = null',
    expect: 'W6B C9：kit/ 去本仓自用泄漏',
  },
  {
    id: 'I438',
    what: 'C10 no-changelog-voice: 扫描源码时禁用 buildLexedViews 剥离字面量',
    file: 'kit/skills/lib/no-changelog-voice.mjs',
    alsoDropIn: ['.agents/skills/lib/no-changelog-voice.mjs'],
    from: '  const scanLines = codeMatch',
    to: '  const scanLines = false && codeMatch',
    expect: 'W6B C10：单源履历词形引擎',
  },
  {
    id: 'I439',
    what: 'C11 feature-map: matchTestsForSourceFile 移除跨生态校验导致 Python 测试误绑到 JS 源码',
    file: 'kit/skills/lib/feature-map.mjs',
    alsoDropIn: ['.agents/skills/lib/feature-map.mjs'],
    from: '    if (srcEco && testEco && srcEco !== testEco) return false',
    to: '    if (false && srcEco && testEco && srcEco !== testEco) return false',
    expect: 'W6B C11：feature-map/repo-map 精度',
  },
  {
    id: 'I440',
    what: 'C11 static-gates: TEST_CASE_RE 去掉 (?<![.\\w$]) 导致 this.test(v) 被误认成测试用例',
    file: 'kit/skills/lib/static-gates.mjs',
    alsoDropIn: ['.agents/skills/lib/static-gates.mjs'],
    from: "export const TEST_CASE_RE = /(?<![.\\w$])(?:it|test|describe|context|suite)(?:\\.(?:skip|only|todo))?\\s*\\(|(?<![.\\w$])(?:xit|xtest|xdescribe|fit|fdescribe)\\s*\\(|\\bdef\\s+test_|#\\[\\s*test\\s*\\]|\\bfunc\\s+Test[A-Z]|@(?:Test|ParameterizedTest)\\b|\\[(?:Fact|Theory)\\b/",
    to: "export const TEST_CASE_RE = /(?:it|test|describe|context|suite)(?:\\.(?:skip|only|todo))?\\s*\\(|(?:xit|xtest|xdescribe|fit|fdescribe)\\s*\\(|\\bdef\\s+test_|#\\[\\s*test\\s*\\]|\\bfunc\\s+Test[A-Z]|@(?:Test|ParameterizedTest)\\b|\\[(?:Fact|Theory)\\b/",
    expect: 'W6B C11：feature-map/repo-map 精度',
  },
  {
    id: 'I441',
    what: 'C19 static-gates-comment-hygiene: isGeneratedSourceHeader 放宽至全文件导致尾部注释伪装自动生成源码',
    file: 'kit/skills/lib/static-gates-comment-hygiene.mjs',
    alsoDropIn: ['.agents/skills/lib/static-gates-comment-hygiene.mjs'],
    from: "  const head25Lines = raw.replace(/\\r\\n/g, '\\n').split('\\n').slice(0, 25)",
    to: "  const head25Lines = raw.replace(/\\r\\n/g, '\\n').split('\\n')",
    expect: 'W6B C12 + C19：edit-gate --base/游离 HEAD 兼容、自动生成源码豁免与纯声明式数据降级',
  },
  {
    id: 'I442',
    what: 'C19 static-gates-comment-hygiene: classifyDeclarativeDataFile 忽略控制流统计导致业务逻辑神文件被误降级',
    file: 'kit/skills/lib/static-gates-comment-hygiene.mjs',
    alsoDropIn: ['.agents/skills/lib/static-gates-comment-hygiene.mjs'],
    from: '  if (controlFlowCount > 0) return null',
    to: '  if (false && controlFlowCount > 0) return null',
    expect: 'W6B C12 + C19：edit-gate --base/游离 HEAD 兼容、自动生成源码豁免与纯声明式数据降级',
  },
]
