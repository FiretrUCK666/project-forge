/**
 * shared.mjs —— 研发工作流内置技能套件的统一向后兼容出口。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），汇总重导出 cli、git、profile、
 * static-gates、ledger、docs、platform 等各正交内核模块的全部公开符号。
 */

export {
  flushAndExit,
  getKnownKitSkills,
  hasSkillSupport,
  parseStandardCli,
  printNextStep,
  resolveAvailableSkills,
  resolveNextSteps,
  withNextSteps,
} from './cli.mjs'

export {
  discoverCustomSkills,
  discoverKitSkills,
  discoverKitSkillsDetailed,
  parseSkillFrontmatter,
} from './skill-discovery.mjs'

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
  withFileLockSync,
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
  discoverEvergreenDocs,
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
  FIXTURE_FILE_RE,
  GATE_ASSERTION_RE,
  GATE_CI_PERM_WRITE_RE,
  GATE_SHELL_BYPASS_RE,
  GATE_SHELL_OR_SCRIPT_RE,
  GATE_SKIP_RE,
  GATE_WORKFLOW_FILE_RE,
  hasBehavioralAssertion,
  isRustLifetimeAt,
  isTestOrFixtureFile,
  isUiVisualFile,
  LOCKFILE_NAMES,
  matchGlob,
  PACKAGE_LOCKFILES,
  RUST_ALLOW_RE,
  scanStructuralHygiene,
  splitDiffByFile,
  stripCodeCommentsLines,
  summarizeHunkChanges,
  TAUTOLOGY_ASSERT_RE,
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
  nextReviewRound,
  readTaskLedger,
  recordMountedDepsInLedger,
  resolveLedgerRoot,
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
  DOC_SHAPE_SIGNALS,
  analyzeDocShapeFromPaths,
  detectDocShapesSync,
  formatDocShapeSkippedBlock,
  parseDocShapeSkippedComment,
  probeWorkspaceDocShape,
  resolveDocShapePolicy,
  validateSkippedSections,
} from './doc-shape.mjs'

export {
  checkCoreSubstantiveness,
  checkDocRegression,
  evaluateMasterPrdClosureState,
  extractDocSnapshot,
  extractTechAnchors,
  isStubValue,
  parseCritiqueAnchors,
  readGitHeadFileSync,
  resolveBaselineSnapshotSync,
  VAGUE_FLUFF_RE,
} from './doc-substantive.mjs'

export {
  buildInspectNextSteps,
  buildSubmitNextSteps,
  determineWorkflowPolicy,
  evaluateNextState,
  GATE_TIER_RANK,
  hasRepoCiWorkflow,
  hydratePrTemplateBody,
  LOW_RISK_TEXT_EXT_RE,
  readVerificationEvidence,
  resolveEffectiveBaseSha,
  resolveReadablePrTitle,
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
  probeForWrite,
  probeGitHubEnv,
  probeSshKeyReadiness,
  probeSshTransport,
  registerHostingProvider,
  removeLabel,
  resolveIdentityLayers,
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
  AGENTS_COMPACT_RECOMMENDED_BYTES,
  AGENTS_MAX_BYTES,
  AGENTS_WARN_BYTES,
  KIT_SKILL_MAX_BYTES,
  KIT_SKILL_WARN_BYTES,
  hasRealContent,
  isToolOwnedPath,
  isToolSkeletonFile,
  isUserExtensionSlot,
  normalizeRelPath,
  projectOwnedPaths,
  TOOL_OWNED_PREFIXES,
  TOOL_SKELETON_FILES,
  USER_EXTENSION_SLOTS,
} from './tool-owned.mjs'

export {
  FORGE_EXTENSIONS_REL,
  FORGE_HOOKS_REL,
  FORGE_OVERLAYS_REL,
  LOCAL_PRE_PUSH_REL,
  VALID_HOOK_STAGES,
  discoverForgeExtensions,
  inspectLocalPrePushHook,
  isAllowedExtensionPath,
  loadForgeHooksConfig,
  loadForgeOverlays,
  resolveStageHookCommands,
  scanExtensionSlotHazards,
  validateForgeHooksConfig,
} from './overlay.mjs'

export {
  FEATURE_MAP_REL,
  cmdCoversTestFile,
  collectConfiguredTestEntries,
  collectJustfileRecipes,
  collectMakefileTargets,
  collectTestInventory,
  expandVerificationCommands,
  isPathInQuickTestScope,
  readFeatureMapSafe,
  resolveNativeTestDir,
  updateFeatureMapTestRefs,
} from './suite-inventory.mjs'

export {
  appendGovernSignal,
  inferSignalModule,
  readSignalsJsonl,
  resolveGovernStateDir,
} from './signals.mjs'

export {
  applyIssuesToBackend,
  buildEscalationIssuePayload,
  buildIssues,
  classifyEscalationTier,
  escalateToBackend,
  formatWorkTitle,
  resolveEscalationBackend,
  workTypePrefix,
} from './escalation.mjs'

export {
  extractHeadlessSummary,
  fencedSpans,
  findFrontmatterEndLine,
  indexMarkdownSections,
  markerPositions,
  scanLines,
  splitSections,
} from './markdown-scan.mjs'

export {
  classifyFileKind,
  discoverContextDocs,
  formatLocateText,
  locateDocuments,
  locateSymbolsInText,
  locateTopSlicesForPaths,
  VALID_LOCATE_KINDS,
  VALID_LOCATE_SCOPES,
} from './doc-locator.mjs'

export {
  DEFAULT_GITHUB_CONCURRENCY,
  addLabelsWithEnsureAndReadback,
  closePrViaRest,
  createLabel,
  mapWithConcurrency,
  normalizeLabelList,
} from './github-labels.mjs'

export {
  INTAKE_BLOCKING_DECISIONS,
  INTAKE_DECISION_TO_LABELS,
  INTAKE_DECISIONS,
  INTAKE_REJECT_LABELS,
  evaluateIntakeTriage,
  hasIntakeBlockingSignal,
  isApprovedInternalPlan,
  readIntakeRecord,
  resolveIntakeDir,
  writeIntakeRecord,
} from './intake-triage.mjs'

export {
  buildClaimComments,
  buildIntakeDecisionComments,
  buildIssueCloseComment,
  buildMergeComments,
  buildReviewComments,
  buildSubmitComments,
  formatAttribution,
} from './doc-comments.mjs'

export {
  indentOf,
  parseYamlScalar,
  readYamlBlockScalar,
  splitInlineArrayItems,
} from './doc-frontmatter.mjs'

export {
  buildContextBrief,
  extractDocBriefSeeds,
  extractDocPaths,
  formatContextBriefLines,
} from './context-brief.mjs'

export {
  ISSUE_QUALITY_RULES,
  extractPlanDocContext,
  extractPlanDocRefsFromText,
  validateIssueBodyQuality,
} from './issue-quality.mjs'

export {
  MUTABILITY,
  evaluateMutability,
} from './mutability.mjs'
