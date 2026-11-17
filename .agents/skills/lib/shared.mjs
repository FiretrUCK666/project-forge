/**
 * shared.mjs —— 研发工作流内置技能套件的统一向后兼容出口。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），汇总重导出 cli、git、profile、
 * static-gates、ledger、docs、platform 七个正交内核模块的全部公开符号。
 */

export {
  flushAndExit,
  parseStandardCli,
  printNextStep,
  resolveAvailableSkills,
} from './cli.mjs'

export {
  buildNonInteractiveEnv,
  canonicalPath,
  COMMON_SKIP_DIRS,
  computeWorktreeEnv,
  DEFAULT_WALK_SKIP_DIRS,
  detectInProgressGitOp,
  detectProjectConventions,
  ensureWorktreesIgnored,
  execSafe,
  execShellCommand,
  gitDiffNameStatusZ,
  gitLsFilesTextAndCode,
  gitRun,
  gitRunBuffer,
  gitStatusPorcelainZ,
  inspectBranchMergeState,
  isMacOsJunkPath,
  isMainModule,
  killProcessTree,
  LIKELY_DEFAULT_BRANCHES,
  parseWorktreeListPorcelain,
  posixPath,
  readJsonSafe,
  readTextSafe,
  resolveDefaultBranch,
  resolveExecutable,
  resolveRepoRoots,
  samePath,
  sha256File,
  sha256Text,
  syncDetachedWorktree,
  unescapeGitPath,
  withFileLock,
  writeAtomic,
  writeJsonAtomic,
} from './git.mjs'

export {
  parsePorcelainV2BranchZ,
  readGitConfigFast,
  readHeadFast,
  readRefsFast,
  resolveDefaultBranchFromRefs,
  resolveGitDirFast,
  resolveRefShaFast,
} from './git-fast.mjs'

export {
  detectEcosystemCommands,
  DEV_PROFILE_KEYS,
  discoverWorkspacePackages,
  hasHumanMergeAuthority,
  isProfileExplicitNone,
  parseAgentsProfile,
  parseDevProfile,
  parseYamlWorkspaceGlobs,
  readDecisionMap,
  readDecisions,
  resolveAuthoritativeTddPath,
  sniffLayeredCommands,
} from './profile.mjs'

export {
  extractYamlRunBlocks,
  NEUTRAL_CI_CONFIGS,
  scanDeclaredTaskRunners,
  scanNeutralCiSteps,
  VENDOR_OR_EXAMPLE_SKIP_DIRS,
} from './profile-sniffer.mjs'

export {
  ASSERTION_RE,
  classifyDoorType,
  CODE_EXT_RE,
  detectGateWeakening,
  detectGateWeakeningInEntry,
  evaluateArchRules,
  EXCUSE_COMMENT_RE,
  EXCUSE_TEMP_RE,
  extractLineCommentInfo,
  GATE_ASSERTION_RE,
  GATE_CI_PERM_WRITE_RE,
  GATE_SHELL_BYPASS_RE,
  GATE_SHELL_OR_SCRIPT_RE,
  GATE_SKIP_RE,
  GATE_WORKFLOW_FILE_RE,
  isRustLifetimeAt,
  LOCKFILE_NAMES,
  matchGlob,
  PACKAGE_LOCKFILES,
  RUST_ALLOW_RE,
  scanStructuralHygiene,
  splitDiffByFile,
  stripCodeCommentsLines,
  summarizeHunkChanges,
  TEST_CASE_RE,
  TEST_FILE_RE,
  TEST_SKIP_RE,
  TOMBSTONE_COMMENT_RE,
  UI_VISUAL_EXT_RE,
} from './static-gates.mjs'

export {
  consumeReviewToken,
  createDefaultLedger,
  ensureReviewToken,
  issueReviewToken,
  listTaskLedgers,
  readTaskLedger,
  resolveTaskContext,
  sanitizeTaskId,
  taskLedgerPath,
  updateTaskLedger,
  writeTaskLedger,
} from './ledger.mjs'

export {
  archiveCompletedDocsGroup,
  buildDocFilename,
  checkMermaidLabelWidth,
  displayWidth,
  DOC_FRONTMATTER_KEY_ORDER,
  DOC_LEGACY_NAME_RE,
  DOC_STANDARD_NAME_RE,
  docDateTag,
  docIsoDate,
  evaluateCoupledSync,
  isSharedMasterPrd,
  MERMAID_LIMITS,
  parseCoupledSyncRules,
  parseDocFilename,
  parseDocFrontmatter,
  renderStandardDocTemplate,
  resolveRepoCustomDocTemplate,
  serializeDocFrontmatter,
  slugify,
  syncDocsLifecycle,
  updateDocFrontmatter,
} from './docs.mjs'

export {
  DEFAULT_OPTIONAL_SECTIONS,
  FORM_INDEPENDENT_CORE,
  checkAuthorIsNotImplementer,
  SECTION_DEFS,
  findMissingSections,
  resolveDocRequirements,
  sectionKeywordMap,
} from './doc-requirements.mjs'

export {
  determineWorkflowPolicy,
  evaluateNextState,
  GATE_TIER_RANK,
  hasRepoCiWorkflow,
  hydratePrTemplateBody,
  LOW_RISK_TEXT_EXT_RE,
  readVerificationEvidence,
  resolveRequiredGates,
  runLowRiskDocStaticCheck,
  validateVerificationEvidence,
  verificationEvidencePath,
  writeVerificationEvidence,
} from './workflow-policy.mjs'

export {
  buildOneClickPrUrl,
  classifyWorkspaceIdentity,
  createGitHubClient,
  createIssue,
  DEFAULT_PROBE_TIMEOUT_MS,
  detectDeclaredRepo,
  detectGitModeMarkers,
  detectRemoteProtocol,
  GENERIC_GIT_PROVIDER,
  getHostingProvider,
  githubHttpsRequest,
  githubRepoFull,
  githubRepoPath,
  hasForkModeMarker,
  hasLocalOnlyMarker,
  hasStandaloneModeMarker,
  isInternalAgentSlug,
  listComments,
  listHostingProviders,
  listOpenPrsByHead,
  lookupSshHost,
  normalizeGitHubRepo,
  parseBodyRelations,
  parseFlowInputs,
  parseIssueNumbers,
  parsePfStateTags,
  parsePrNumber,
  parseRemoteUrlHost,
  parseRemotesTopology,
  parseRemoteUrls,
  parseSshConfigDetails,
  parseSshConfigHostMap,
  probeGitHubEnv,
  probeSshKeyReadiness,
  probeSshTransport,
  registerHostingProvider,
  removeLabel,
  resolveContributorIdentity,
  resolveRemoteDescriptor,
  resolveWorkspaceIdentity,
  summarizeCommitChecks,
} from './platform.mjs'

export {
  createTaskBackend,
  GenericRemoteBackend,
  GitHubBackend,
  LocalOnlyBackend,
  TASK_BACKEND_METHODS,
} from './task-backend.mjs'

export {
  assertNoDuplicatePrForTask,
  checkStackedParentMerged,
  checkUnresolvedDependencies,
  checkUntrustedPrGate,
  resolveExternalCollaborationGraph,
} from './task-graph.mjs'

export { checkTddSyncParity } from './tdd-parity.mjs'

export {
  failedVerdict,
  isOk,
  mergeVerdicts,
  needsAttention,
  okVerdict,
  unavailableVerdict,
  VERDICT_STATES,
  verdictFromError,
  verdictLabel,
} from './verdict.mjs'

export {
  hasRealContent,
  isToolOwnedPath,
  isToolSkeletonFile,
  normalizeRelPath,
  projectOwnedPaths,
  TOOL_OWNED_PREFIXES,
  TOOL_SKELETON_FILES,
} from './tool-owned.mjs'

export {
  appendGovernSignal,
  inferSignalModule,
  readSignalsJsonl,
  resolveGovernStateDir,
} from './signals.mjs'
