/**
 * static-gates-assertions.mjs —— 栈无关多语言行为断言识别家族模型。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），被 static-gates / test-inventory / govern-tests / edit-gate 共用。
 * 识别各生态真实行为断言（tape/ava/node:test receiver 方法、Python self.assert*、PHP $this->assert*、
 * Ruby assert_* / refute_*、Swift #expect/#require 等），同时严格排除 t.plan/t.end/t.comment/t.skip/t.todo 等空壳调用。
 */

const DEFAULT_CORE_ASSERTION_RE = /\b(?:[Aa]ssert(?:\.\w+)?|[Ee]xpect|[Ss]hould|pytest\.raises|t\.(?:Error|Errorf|Fatal|Fatalf|Fail)|assert_(?:eq|ne|matches)?|[Aa]ssert(?:Equals?|NotEquals?|DeepEqual|NoError|Error|Contains|True|False|Throws|Null|NotNull|That)|strictEqual|deepStrictEqual|equal|notEqual|throws|rejects|match|XCTAssert\w*|EXPECT_[A-Z0-9_]+|ASSERT_[A-Z0-9_]+|REQUIRE|CHECK)\b\s*(?:\(|!|\.)|\b[Aa]ssert\s+/

export const NON_ASSERTION_RECEIVER_METHODS = new Set([
  'plan', 'end', 'comment', 'skip', 'todo', 'only', 'timeout', 'teardown',
  'before', 'after', 'beforesuite', 'aftersuite', 'beforeeach', 'aftereach',
  'log', 'diagnostic', 'run', 'parallel', 'helper', 'cleanup', 'setenv', 'tempdir',
])

const ASSERTION_RECEIVER_METHOD_RE = /(?:^|[^\w$.])(?:t|test|assert)\.(ok|notOk|true|false|truthy|falsy|is|not|equal|notEqual|equals|strictEqual|notStrictEqual|deepEqual|notDeepEqual|deepStrictEqual|notDeepStrictEqual|same|notSame|strictSame|strictNotSame|throws|doesNotThrow|notThrows|throwsAsync|notThrowsAsync|rejects|doesNotReject|match|doesNotMatch|regex|notRegex|like|snapshot|ifError|error|pass|fail|Error|Errorf|Fatal|Fatalf|Fail|FailNow|assert)\s*\(/g

export const ASSERTION_FAMILIES = Object.freeze({
  selfOrThisReceiver: /\bself\.assert[A-Za-z0-9_]*\s*\(|\$this->assert[A-Za-z0-9_]*\s*\(/,
  rubyAssertOrRefute: /\b(?:assert_[a-z0-9_]+|refute(?:_[a-z0-9_]+)?)\s*(?:\(|(?![=.:])[^\s;)}\]\n])/,
  swiftMacroExpect: /#\s*(?:expect|require)\s*\(/,
  rustMacroAssert: /\b(?:assert|assert_eq|assert_ne|debug_assert|debug_assert_eq|debug_assert_ne)!\s*\(/,
  javaJunitAssert: /\bAssertions\.[A-Za-z0-9_]+\s*\(/,
})

function hasReceiverAssertionMethod(codeText) {
  ASSERTION_RECEIVER_METHOD_RE.lastIndex = 0
  let m
  while ((m = ASSERTION_RECEIVER_METHOD_RE.exec(codeText)) !== null) {
    const method = String(m[1] ?? '').toLowerCase()
    if (!NON_ASSERTION_RECEIVER_METHODS.has(method)) return true
  }
  return false
}

/**
 * 判断词法剥离注释后的代码片段是否至少包含一处跨生态真实行为断言。
 * 排除 `t.plan` / `t.end` / `t.comment` / `t.skip` / `t.todo` 等非断言生命周期调用。
 */
export function hasBehavioralAssertion(codeOnlyText, { ext = '', assertionRe = null } = {}) {
  const code = String(codeOnlyText ?? '')
  if (!code.trim()) return false
  const coreRe = assertionRe ?? DEFAULT_CORE_ASSERTION_RE
  if (coreRe.test(code)) return true
  if (ASSERTION_FAMILIES.selfOrThisReceiver.test(code)) return true
  if (ASSERTION_FAMILIES.rubyAssertOrRefute.test(code)) return true
  if (ASSERTION_FAMILIES.swiftMacroExpect.test(code)) return true
  if (ASSERTION_FAMILIES.rustMacroAssert.test(code)) return true
  if (ASSERTION_FAMILIES.javaJunitAssert.test(code)) return true
  if (hasReceiverAssertionMethod(code)) return true
  if (/^(?:py|pyi)$/i.test(ext) && /\bpytest\.warns\s*\(/.test(code)) return true
  return false
}
