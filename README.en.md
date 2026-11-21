<p align="center">
  <img src="assets/readme/hero-en.svg" alt="project-forge: read-only survey first, then fit Git baselines, three-layer docs, eight daily skills, and merge gates" width="100%">
</p>

<p align="center">
  <a href="README.md">简体中文</a> | <strong>English</strong>
</p>

<p align="center">
  <a href="RELEASING.md"><img src="https://img.shields.io/badge/version-v6.0.0-4E7496?style=flat-square" alt="Version v6.0.0"></a>
  <a href="#install"><img src="https://img.shields.io/badge/node-%3E%3D18-1F6F5B?style=flat-square" alt="Node.js 18 or newer"></a>
  <a href="SKILL.md"><img src="https://img.shields.io/badge/dependencies-0-1F6F5B?style=flat-square" alt="Zero third-party dependencies"></a>
  <a href="#supported-languages"><img src="https://img.shields.io/badge/languages-any-D96B27?style=flat-square" alt="Works with any language"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-526075?style=flat-square" alt="MIT License"></a>
</p>

In a new folder or a repository maintained for months, most wasted time sits outside the product code: `.gitignore` misses local secrets, design docs drift away from the codebase, branches merge without real test output, and changing one file gives no hint about which linked files must move with it.

**project-forge** surveys a folder read-only first, then fits the Git baseline, three-layer evergreen docs, the `AGENTS.md` contract, remote-aware CI workflows (supporting GitHub, `generic-git`, and `local-only`—skipping GitHub Actions when not applicable), and eight local development skills. It preserves handwritten files, installs zero third-party packages, and runs on Node.js 18 or newer.

## What It Does

| Capability | What that means |
| --- | --- |
| **Keep handwritten files intact** | Existing `README.md`, `CONTRIBUTING.md`, architecture docs, custom templates, CI workflows, and custom skills stay untouched. An external `.zip` snapshot is saved before any write (with `.tar.gz` restore compatibility) |
| **Dual-mode plans and wave scheduling** | Supports `interactive` and `autonomous` planning modes, isolated planning worktrees with `plan-sync`, a single 3-state slice dependency graph checking coverage and file overlap, and slim subagent handoff packets |
| **Worktree isolation and real proof** | Repositories with commit history use reusable `.worktrees/` slots where the implementer owns claim and PR submission. Verification checks real non-empty `--artifact` files and blocks UI changes that rely on `--visual-checked` alone |
| **Adaptive remotes and local fallback** | A unified `TaskBackend` handles GitHub (including multi-remote setups and SSH aliases), `local-only` repos, and `generic-git` non-GitHub remotes without forcing local merges on unverified upstreams |
| **PoC-first and bounded iteration** | Minimal runtime reproduction (`PoC-first`) weeds out false alarms before any patch is written, and `iterate.mjs cycle` runs a bounded loop with three hard stop-loss exits. Gates lock objective outputs only, and recurring patterns promote into static checks |

## Contents

<!-- toc:start -->

- [What It Does](#what-it-does)
- [External Governance and Upgrades](#external-governance-and-upgrades)
- [Eight Daily Skills and Workflow](#eight-daily-skills-and-workflow)
- [Bounded Optimization Loop and PoC-First](#bounded-optimization-loop-and-poc-first)
- [Three-Layer Evergreen Docs and Slicing](#three-layer-evergreen-docs-and-slicing)
- [Supported Languages](#supported-languages)
- [Install](#install)
- [Automatic Updates](#automatic-updates)
- [Guardrails](#guardrails)
- [Script Reference](#script-reference)
- [License](#license)

<!-- toc:end -->

## External Governance and Upgrades

<p align="center">
  <img src="assets/readme/workflow-en.svg" alt="Three repository starting points entering the S1 to S4 pipeline with external snapshots before writes" width="100%">
</p>

Empty directories, partially configured repositories, and older setups returning for an upgrade all move through the same four steps: **S1 Read-only Survey → S2 Scope and Fusion → S3 Backup and Ordered Write → S4 Review and Handoff**:

| Step | What happens | Key safeguard |
| --- | --- | --- |
| **S1 Read-only Survey** | Inventories directory layout, ecosystems, Git remotes, local credentials, existing design docs, and custom skills | Writes nothing; an empty folder answers 3 to 4 questions first |
| **S2 Scope and Fusion** | Keeps evergreen docs, scripts, and existing AI rules, archives stale notes, and skips team-only files for solo repos | License, visibility, and release strategy always wait for human choice |
| **S3 Backup and Write** | Creates an external `pre-forge` `.zip` snapshot for non-empty repos, runs existing tests as a baseline, then writes in order | Order is fixed: **Repo → docs → remote → automation** |
| **S4 Review and Handoff** | Checks contract alignment and claim reality, then files discovered legacy issues into `TaskBackend` for normal follow-up | Lists scaffold markers before cleaning; keeps `.pf-manifest.json` when skills stay |

Step 3 keeps a strict order because `.gitattributes` and `.gitignore` must be in place before the first commit, docs and remote URLs must exist before the first push, and CI must run the exact commands listed in `AGENTS.md` and `README.md`.

Across upgrades, `equip.mjs` tracks managed files through `.agents/skills/.pf-manifest.json` (`v3` manifest):

- **Tombstone protection**: skills or single files removed by the user are recorded in `disabledSkills` and `removedFiles` and never re-added unless `--restore` is passed.
- **Custom exemptions and 3-way merge**: files registered via `--adopt-custom` pass `--check`; non-script edits merge cleanly with `merge3.mjs`, while `.mjs` conflicts keep the local file without conflict markers.
- **Instant rollback**: if ESM syntax or export checks fail after an upgrade, `equip-integrity.mjs` restores the whole suite from the external `.zip` snapshot.

## Eight Daily Skills and Workflow

<p align="center">
  <img src="assets/readme/architecture-en.svg" alt="Role division across the eight built-in skills and the four merge gates" width="100%">
</p>

Daily work installs all eight skills across eight stages: **Requirement → Clarification → Design → Implementation → Review → Empirical & Formal Verification → Acceptance → Merge**.

Describe your goal in plain language—or paste Issue, PR, or Milestone URLs—and `AGENTS.md` routes to the matching skill silently. You can also run each underlying CLI script directly.

| Skill | Plain-language example | Skill & CLI entry | Role and core gates |
| --- | --- | --- | --- |
| `dev-explore` | "Map the export module and test commands" | `repo-map.mjs`, `doc-locate.mjs` | Read-only; returns line-range slices, entry points, and feature-map seeds |
| `dev-plan` | "Clarify scope and plan slices" | `doc-plan.mjs` | 5-case triage, `interactive` / `autonomous` modes, `plan-sync`, 3-state slice graph, distinct Critique |
| `dev-edit` | "Check boundaries and static gates" | `edit-gate.mjs` | Checks `do-not-edit` and reuse; blocks unanchored suppressions, dead comments, `arch-rules`, test cheats, >800 lines |
| `dev-flow` | "Work in an isolated slot and open a PR" | `flow.mjs` | Reusable `.worktrees/` slots, `batch plan --handoff` packets, implementer submit, `1:N` closure, `--artifact`, 7-step cleanup |
| `dev-verify-tools` | "Check or add feature-map verification tools" | `verify-tools.mjs` | Keeps `docs/feature-map.json`, prototypes in external `scratch/`, checks symbol & tree hashes |
| `dev-review` | "Review this PR independently" | `review-pack.mjs` | External `--untrusted-scan`, proof-first before `--include-diff`, fresh Round 2+ reviewer, 6-lock convergence |
| `dev-iterate` | "Probe test gaps and run a bounded cycle" | `iterate.mjs` | Generates `edit-gate`-checked native tests, concurrent runs, `PoC-first` + `escalation.mjs`, bounded `cycle` |
| `dev-govern` | "Audit repo health or extract retro rules" | `govern-audit.mjs` | Static audit, `reconcile`, signal clustering, commit `sample`, and `retro` (promotes >=2 recurrences) |

**What can be skipped by tier:**

- **Case 1 (typos or single-line formatting)**: skip exploration and planning docs, make the edit, and run the matching check.
- **Case 2 (local bugfix without contract changes)**: skip planning docs, but write a failing regression test first before fixing (Red-Green).
- **`high-risk`, `one-way`, or Case 4 changes**: review must run in a separate independent context with fault injection. Reviewing your own changes does not count.

## Bounded Optimization Loop and PoC-First

<p align="center">
  <img src="assets/readme/skills-cycle-en.svg" alt="Four-phase iterate.mjs cycle state machine and three hard stop-loss limits" width="100%">
</p>

When investigating gaps or review findings, `dev-iterate`, `dev-review`, and `dev-govern` share one rule: **run a minimal reproduction (`PoC-first`) to confirm the issue before writing any fix**.

1. **Observe**: rank test gaps and hotspots from `docs/feature-map.json`, `signals.jsonl`, and recent diffs without editing source files.
2. **PoC-first**: execute one minimal reproduction command. If a suspected static issue cannot be reproduced, drop it as a false alarm without writing a patch.
3. **Escalate & Fix**: file an issue via `escalation.mjs` with `pocCommand` and `reproEvidence`, fix it on the normal `dev-plan → dev-edit → dev-flow → dev-review` path, and re-run the same PoC with `--artifact` proof.
4. **Reflect**: check whether the bug reflects a whole class of errors—prioritize a Tier 1 architectural or shared-boundary refactor, and add a Tier 2 deterministic static rule or type gate. All gates lock objective output boundaries (artifacts, schemas, exit codes, and bidirectional tests) instead of fragile internal steps.

`iterate.mjs cycle` orchestrates these four read-only phases and halts with exit code `4` for a human decision whenever any stop-loss limit fires:

- **`ROUND_LIMIT_REACHED`**: reaches the round limit (`3` rounds by default, hard cap `10`).
- **`NO_PROGRESS_STALL`**: `2` consecutive rounds produce no new verified progress.
- **`ONE_WAY_GATE_HIT`**: hits an irreversible or high-risk change awaiting approval.

## Three-Layer Evergreen Docs and Slicing

<p align="center">
  <img src="assets/readme/docs-layers-en.svg" alt="Three evergreen doc layers, on-demand doc-locate slicing, and four-layer planning closure" width="100%">
</p>

Project knowledge lives in **three evergreen layers** alongside **four planning folders**. During daily tasks, `doc-locate.mjs` returns `startLine..endLine` slices by heading or symbol so long files are never dumped whole into context:

| Layer | File | Purpose and freshness check |
| --- | --- | --- |
| **L1 Entry contract** | `AGENTS.md` | Compact session contract: intent routing, engineering principles, `Dev Profile`, collaboration rules, `high-risk` paths, and coupled-edit map (`< 24KB` target, `<= 30KB` cap) |
| **L2 System architecture** | `docs/TDD.md` | Current module boundaries, workflows, `16/12` Mermaid diagrams, and invariants; checked by `tdd-structure.mjs` and `tdd-parity.mjs` |
| **L3 Machine index** | `docs/feature-map.json` | Single machine-readable map of features, entry points, business flows, and verification tools checked via symbol and tree hashes by `verify-tools.mjs` |
| **Planning & archive** | `docs/{prd,specs,todo}/` → `docs/archive/` | `doc-plan.mjs` cleans scaffold placeholders and respects custom repo templates; `flow finalize` verifies all `[x]` criteria and `1:N` master PRD closure before moving pairs with `git mv` |

## Supported Languages

**Any language works.** Language only decides how precisely commands are inferred from manifests; it never blocks the workflow.

| Situation | What happens |
| --- | --- |
| **Recognized manifests (12)** | `Node.js`, `Python`, `Rust`, `Go`, `Java`, `Ruby`, `PHP`, `.NET`, `C/C++`, `Dart`, `Swift`, and `Elixir` yield idiomatic build, test, and install commands |
| **Any other language** | Haskell, OCaml, Zig, Nim, Crystal, Julia, or an internal DSL: commands are read from what the repo **already runs** in CI `run:` blocks, `Makefile`, `justfile`, or `Taskfile` |
| **Empty folder bootstrap** | `equip.mjs --bootstrap-empty` generates a universal baseline (Git baseline, three-layer docs, `docs/TDD.md`, `AGENTS.md`, and 8 skills) with zero toy business code across `14` stack presets (`12` languages plus `universal` and `docs`, defaulting to `universal`) while preserving `README.md` and `LICENSE` |

Documentation-only repos, editor extensions, Obsidian plugins, and capability folders are also supported. When neither manifests nor CI/task files exist, the survey reports honestly that no command was found and lists where to look instead of guessing.

## Install

**Requirements**: `Windows`, `macOS`, or `Linux`, with `Node.js 18` (`>= 18`) or newer. Every script uses built-in Node modules only, so there is no `npm install` step.

| Option | How | Updates | For whom |
| --- | --- | --- | --- |
| **Download archive** | [Download project-forge.zip (latest)](https://github.com/FiretrUCK666/project-forge/releases/latest/download/project-forge.zip) | Automatic | Everyday users |
| **`git clone`** | `git clone https://github.com/FiretrUCK666/project-forge.git` | Reports only; you run `git pull` | People modifying the tool itself |

With either option, **keep the directory named `project-forge`**. Suffixes like `project-forge-main` prevent hosts from matching the folder name to the skill name.

Once installed, open the project folder you want to organize and ask:

```text
Survey the current folder first and list what is missing and how you would organize it.
```

## Automatic Updates

Only the **archive copy** checks and updates automatically. A `git clone` copy is never overwritten.

| Question | Answer |
| --- | --- |
| **Check cadence** | Checks at most once every **1 hour** after a successful check, waits **15 minutes** after a failure so offline work never stalls, and skips checks for **24 hours** after an update |
| **Atomic replacement** | Downloads to a same-disk staging folder, unpacks, validates, writes supporting files first, and replaces `SKILL.md` atomically. Any error rolls back cleanly |
| **Disable or mirror** | Set `PF_NO_UPDATE=1` to turn off checks, or set `PF_UPDATE_SOURCE` to point at a mirror |

```sh
# Check once right now; reports status without modifying files
node "<skill directory>/scripts/update.mjs" --check

# Turn automatic update checks off
PF_NO_UPDATE=1

# Point at a mirror repository
PF_UPDATE_SOURCE="https://github.com/<owner>/project-forge"
```

## Guardrails

Daily operations split into two tiers based on **whether they can be undone**:

| Tier | Actions | Human confirmation |
| --- | --- | --- |
| **Undoable** | Local commits, pushing your own branch, opening or editing a PR, running checks | None; revert or redo anytime |
| **Not undoable** | Merging into the default branch, tagging a release, publishing, changing visibility, rewriting pushed history | Required; actions are listed for approval first |

Two additional hard rules apply everywhere:

- **Weakening a gate requires human sign-off**: deleting tests, relaxing assertions, adding skip markers, or loosening CI checks must be approved by a person.
- **Force-push is never automatic**: nothing runs `git push --force` or rewrites pushed history on its own.

When an independent review passes with zero open findings, the **reviewer merges directly**—reviewers act as the gate, not just advisors.

## Script Reference

Daily workflows route through `AGENTS.md`, so you do not need to memorize these commands. Use them when troubleshooting or wiring checks into CI.

<details>
<summary>Show underlying scripts and responsibilities</summary>

| Script | Purpose |
| --- | --- |
| `node scripts/survey.mjs <dir>` | Read-only inventory of layout, docs, remote topology, and auth state |
| `node scripts/backup.mjs create <dir>` | Create an incremental `.zip` snapshot outside the repository (`list` / `restore`) |
| `node scripts/equip.mjs <dir>` | Install or losslessly refresh `.agents/skills/` (`--check`, `--adopt-custom`, `--restore`, `--bootstrap-empty`) |
| `node scripts/compose-agents.mjs <dir>` | Generate or refresh `AGENTS.md` (`< 24KB` target, `<= 30KB` cap) |
| `node scripts/equip-ci.mjs <dir>` | Write CI workflows from survey facts or configure branch protection |
| `node scripts/review.mjs <dir>` | Delivery check for contract completeness and claim verification |
| `node scripts/handoff.mjs <dir>` | Scan scaffold markers and temporary leftovers before handoff |
| `node scripts/sync-toc.mjs README.md README.en.md` | Keep bilingual README tables of contents in sync |
| `node scripts/update.mjs [--check]` | Check and atomically apply updates to the archive copy |

</details>

## License

This project is released under the [MIT](LICENSE) license. See [CONTRIBUTING.md](CONTRIBUTING.md) and [RELEASING.md](RELEASING.md) for details.
