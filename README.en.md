<p align="center">
  <img src="assets/readme/hero-en.svg" alt="project-forge: survey-first repository governance for version control, evergreen docs, and eight local skills with zero dependencies across multi-remote and local-only setups" width="100%">
</p>

<p align="center">
  <a href="README.md">简体中文</a> | <strong>English</strong>
</p>

<p align="center">
  <a href="RELEASING.md"><img src="https://img.shields.io/badge/version-v6.0.0-4E7496?style=flat-square" alt="Version v6.0.0"></a>
  <a href="#install-and-automatic-updates"><img src="https://img.shields.io/badge/node-%3E%3D18-1F6F5B?style=flat-square" alt="Node.js 18 or newer"></a>
  <a href="SKILL.md"><img src="https://img.shields.io/badge/dependencies-0-1F6F5B?style=flat-square" alt="Zero third-party dependencies"></a>
  <a href="#supported-languages"><img src="https://img.shields.io/badge/languages-any-D96B27?style=flat-square" alt="Works with any language"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-526075?style=flat-square" alt="MIT License"></a>
</p>

As a repository grows, common failures rarely come from product logic alone: files get harder to follow, design docs drift away from the code, and AI edits focus on the current line while missing linked constraints.

**project-forge** surveys a folder read-only first, then fits version control baselines, three-layer evergreen docs, the `AGENTS.md` contract, remote-aware checks, and eight local development skills. It keeps handwritten files intact, installs zero third-party packages, and runs on Node.js 18 or newer.

## Contents

<!-- toc:start -->

- [Install and Automatic Updates](#install-and-automatic-updates)
- [Problems It Solves](#problems-it-solves)
- [Workflows and Daily Usage](#workflows-and-daily-usage)
- [Eight Local Development Skills](#eight-local-development-skills)
- [Supported Languages](#supported-languages)
- [Guardrails](#guardrails)
- [Script Reference](#script-reference)
- [License](#license)

<!-- toc:end -->

## Install and Automatic Updates

**Requirements**: Windows, macOS, or Linux with `Node.js 18` (`>= 18`) or newer. Every script uses built-in Node modules only, so `npm install` is never needed.

| Option | Source | Updates | Best for |
| --- | --- | --- | --- |
| **Download archive** | [Download project-forge.zip (latest)](https://github.com/FiretrUCK666/project-forge/releases/latest/download/project-forge.zip) | Automatic updates with atomic rollback | Everyday use |
| **`git clone`** | `git clone https://github.com/FiretrUCK666/project-forge.git` | Checks and notifies only; run `git pull` manually | Modifying the tool itself |

With either option, **keep the directory named `project-forge`**. Suffixes like `project-forge-main` prevent hosts from matching the folder name to the skill name.

Once installed, open the project folder you want to organize and tell the AI:

```text
Survey the current folder first and list what is missing and how you would organize it.
```

<details>
<summary>Show automatic update cadence and environment flags</summary>

Only the **archive copy** checks and updates automatically. A `git clone` copy is never overwritten.

| Item | Behavior |
| --- | --- |
| **Check cadence** | Checks at most once every 1 hour after a successful check, waits 15 minutes after a failure so offline work never stalls, and skips checks for 24 hours after an update |
| **Atomic replacement** | Downloads to a same-disk staging folder, unpacks, validates, writes supporting files first, and replaces `SKILL.md` atomically; any failure rolls back cleanly |
| **Disable or mirror** | Set `PF_NO_UPDATE=1` to turn off automatic checks, or set `PF_UPDATE_SOURCE` to point at a mirror repository |

```sh
# Check once right now; reports status without modifying files
node "<skill directory>/scripts/update.mjs" --check

# Turn automatic update checks off
PF_NO_UPDATE=1

# Point at a mirror repository
PF_UPDATE_SOURCE="https://github.com/<owner>/project-forge"
```

</details>

## Problems It Solves

- **Read-only survey first, external snapshot before any write**: Existing `README.md`, `CONTRIBUTING.md`, architecture docs, custom templates, CI workflows, and custom skills stay untouched. Before writing any file, an external `.zip` snapshot (with `.tar.gz` restore compatibility) is saved for full rollback.
- **Work inside isolated `.worktrees/` slots to keep `main` clean**: Repositories with commit history run implementation and review in separate `.worktrees/` branches, and whoever edits the code owns the claim and PR submission.
- **Independent review for both plans and code**: Complex tasks run multi-round clarification until zero open decisions remain, then pass an independent plan review (up to 3 critique rounds; self-review is blocked). Code changes go through a fresh independent review context, and high-risk paths require fault-injection tests.
- **Reproduce first, accept real output only**: Suspected bugs require a minimal reproduction before writing a patch, and bugfixes start with a failing regression test. Acceptance requires real `--artifact` attachments or command output rather than verbal claims on UI edits, and bugs recurring twice are turned into static checks.
- **No lock-in to one language or host**: Twelve package manifests yield idiomatic commands automatically, and any other language reads existing build or CI commands. GitHub (including multi-remote setups and SSH aliases), non-GitHub remotes (`generic-git`), and local-only folders (`local-only`) all work cleanly without generating inapplicable GitHub Actions or forcing local merges on unverified upstreams.

## Workflows and Daily Usage

### First-Time Setup or Upgrades: S1 to S4

<p align="center">
  <img src="assets/readme/workflow-en.svg" alt="S1 to S4 governance pipeline: read-only survey (survey.mjs), confirm scope while keeping custom files, pre-write external .zip snapshot with full rollback, and audit and handoff (review and handoff)" width="100%">
</p>

Empty directories, partially configured repositories, and older setups returning for an upgrade all follow four steps: **S1 Read-only Survey → S2 Scope and Fusion → S3 Backup and Ordered Write → S4 Review and Handoff**:

| Step | What happens | Key safeguard |
| --- | --- | --- |
| **S1 Read-only Survey** | Inventories directory layout, language ecosystems, Git remotes, local credentials, existing design docs, and custom skills | Writes nothing; empty directories answer 3 to 4 setup questions first |
| **S2 Scope and Fusion** | Keeps evergreen docs, scripts, and existing AI rules, archives stale notes, and skips inapplicable team templates | License, repository visibility, and release policy wait for human choice |
| **S3 Backup and Ordered Write** | Saves an external `pre-forge` `.zip` snapshot for non-empty repos, runs existing tests as a baseline, then writes in order | Order is fixed: **Repo → docs → remote → automation** |
| **S4 Review and Handoff** | Checks contract alignment and claim reality, then files discovered legacy issues for normal follow-up | Lists scaffold markers before cleaning; keeps `.pf-manifest.json` when skills stay |

Step 3 keeps a fixed order because `.gitattributes` and `.gitignore` must be in place before the first commit, docs and remote URLs must exist before the first push, and CI must run the exact commands listed in `AGENTS.md` and `README.md`.

Across upgrades, `equip.mjs` tracks managed files in `.agents/skills/.pf-manifest.json`: skills or files removed by the user are recorded as tombstones and stay deleted unless `--restore` is passed; registered custom edits pass checks; non-script edits merge cleanly in three ways while `.mjs` conflicts keep the local file; and any post-upgrade syntax or export failure rolls back from the external `.zip` snapshot.

### Daily Conversations and Worktree Topology

<p align="center">
  <img src="assets/readme/architecture-en.svg" alt="Main branch and isolated worktree topology: .worktrees/impl runs explore, plan, edit, and flow, .worktrees/review gates independent merge via dev-review, supported by outer-loop skills dev-verify-tools, dev-iterate, and dev-govern" width="100%">
</p>

In daily work, you do not need to memorize commands or stage names. State what you want in plain language—or paste Issue, PR, or Milestone links—and `AGENTS.md` routes through the eight stages: **Requirement → Clarification → Design → Implementation → Review → Empirical & Formal Verification → Acceptance → Merge**:

| Everyday situation | What we can say | Stages and skills triggered |
| --- | --- | --- |
| **Typo or single-line fix (Case 1)** | "Fix this typo in the config comment" | Skips planning docs, edits directly, and runs the matching check |
| **Clear local bugfix (Case 2)** | "The login endpoint crashes on empty input, please fix it" | Writes a failing regression test first in `.worktrees/impl-*`, fixes it, passes `dev-edit` static checks, opens a PR, and merges via independent `dev-review` |
| **New feature or cross-module change (Case 3 / Case 4)** | "Add a CSV export feature for reports" | `dev-explore` reads source slices → `dev-plan` clarifies open questions, writes the spec, and runs up to 3 rounds of independent critique → `dev-flow` opens `.worktrees/impl-*` and passes `dev-edit` → `dev-review` runs an independent review and merges → 7-step cleanup asks before deleting worktrees and branches |
| **Mid-task scope changes** | "Add a date filter too and adjust the export columns" | Clarifies new differences first and updates `docs/specs/` or files a follow-up task instead of relying on chat memory |
| **Periodic test and health pass** | "Check recent changes for test gaps and audit repo health" | `dev-iterate` adds native regression tests, `dev-verify-tools` checks and updates endpoint probes, and `dev-govern` runs a static audit and turns recurring bugs into checks |

### Bounded Optimization Loop and PoC-First

<p align="center">
  <img src="assets/readme/skills-cycle-en.svg" alt="Eight-skill lifecycle loop: dev-explore through dev-review with max 3-round plan critique and code rework arcs, connected to outer-loop dev-govern, dev-iterate, and dev-verify-tools with defect escalation" width="100%">
</p>

When checking test blind spots, review findings, or audit warnings, `dev-iterate`, `dev-review`, and `dev-govern` follow one rule: **run a minimal reproduction (`PoC-first`) to confirm the bug before writing any patch**. Unreproducible static suspicions are dropped as false positives.

1. **Observe**: Rank test blind spots and hotspots from the feature map, historical signals, and recent diffs without editing source files.
2. **PoC-first**: Execute one minimal command to confirm the failure is real.
3. **Escalate & Fix**: File an issue carrying the reproduction command and output, fix it on the normal development and review path, and re-run the same command with real proof.
4. **Reflect**: Check whether the defect points to a broader gap, harden the shared boundary first, and promote deterministic rules into static gates.

The automated cycle halts with exit code `4` for a human decision whenever it hits a round cap (`ROUND_LIMIT_REACHED`, default 3 rounds, hard cap 10), `2` rounds with no verified progress (`NO_PROGRESS_STALL`), or an irreversible/high-risk change (`ONE_WAY_GATE_HIT`).

### Three-Layer Evergreen Docs and On-Demand Slicing

<p align="center">
  <img src="assets/readme/docs-layers-en.svg" alt="Three evergreen doc layers (AGENTS.md routing and hard invariants, docs/TDD.md section-read architecture, docs/feature-map.json modules and verify tools) with four-layer planning archive flow" width="100%">
</p>

Project knowledge lives in three evergreen layers alongside four planning folders. During daily work, `doc-locate.mjs` reads targeted `startLine..endLine` slices by heading or symbol so long files are never dumped whole into context:

| Layer | File | Role and freshness check |
| --- | --- | --- |
| **L1 Entry contract** | `AGENTS.md` | Thin session contract: intent routing, engineering principles, build/test commands, collaboration rules, `high-risk` paths, and coupled-edit map (`< 24KB` target, `<= 30KB` cap) |
| **L2 System architecture** | `docs/TDD.md` | Current module boundaries, flows, diagrams, and invariants checked against actual paths |
| **L3 Machine index** | `docs/feature-map.json` | Single machine-readable map of features, modules, flows, and verification tools checked via exported symbol hashes and Git tree hashes |
| **Planning & archive** | `docs/{prd,specs,todo}/` → `docs/archive/` | Freezes `C1..Cn` acceptance criteria and pairs them into `docs/archive/` via `git mv` once all checks pass before PR submission |

## Eight Local Development Skills

**These eight skills run together automatically in daily workflows, and every single one can also be used on its own. You do not need slash commands—describe what you want in plain language, or run the CLI script directly.**

| Skill | What it does | When to use it alone | What we can say to the AI | Actions & CLI entry |
| --- | --- | --- | --- | --- |
| **`dev-explore`** | Surveys layout, entry points, and reusable modules read-only, and slices docs or symbols on demand | Starting in an unfamiliar codebase or tracing a module before editing | "Map the export module entry points and existing helpers" | **Strictly read-only**; edits no files and switches no branches (`doc-locate.mjs`, `repo-map.mjs`) |
| **`dev-plan`** | Triages tasks (Case 1–5), clarifies open questions, drafts specs/todos with `C1..Cn` criteria, and runs independent critique | Before starting a cross-module feature where scope and contracts must settle first | "Clarify this feature request and write a spec before editing code" | Writes planning docs in `docs/{prd,specs,todo}/` without editing source code (`doc-plan.mjs`) |
| **`dev-edit`** | Checks `do-not-edit` zones and reuse before edits, then scans code (stripping comments/literals) for suppressions, dead comments, `arch-rules`, test cheats, and >800-line files | After local edits when you want a fast static gate check before committing | "Run the static edit gate on my changed files" | **Read-only check and block**; does not rewrite source files (`edit-gate.mjs`) |
| **`dev-flow`** | Manages `.worktrees/` slots, task claims, doc archiving, artifact verification, PR submission, merges, and 7-step cleanup | Opening an isolated feature branch, syncing `main`, running merge gates, or cleaning merged worktrees | "Create an isolated worktree for this task and prepare the PR" | Creates or removes `.worktrees/` and branches, archives docs, runs checks, and submits (`flow.mjs`) |
| **`dev-verify-tools`** | Maintains `docs/feature-map.json`, prototypes probes in external `scratch/`, and detects stale verification tools by symbol and tree hashes | After changing an API when you want to find matching checks or add a verification script | "Check which verification tools cover this change or add one" | Writes probes in external `scratch/`, promotes checked scripts, and updates `docs/feature-map.json` (`verify-tools.mjs`) |
| **`dev-review`** | Builds isolated review packets, scans untrusted external PRs, enforces proof-first checks before unlocking diffs, supports fresh Round 2+ reviews, and merges on pass | Reviewing your own PR or an external PR from an independent perspective | "Review this PR from an independent context" | Reads and runs checks in `.worktrees/review-*`, merging only when zero findings remain (`review-pack.mjs`) |
| **`dev-iterate`** | Cross-checks the feature map, signals, and recent diffs for test gaps, generates native tests, runs them concurrently, and files `PoC-first` issues on real failures | Hardening an under-tested module or running a bounded regression and stress pass | "Add regression tests for the auth module and probe blind spots" | Writes native test files and runs them concurrently; never edits product source code (`iterate.mjs`) |
| **`dev-govern`** | Runs read-only static audits (security, dead code, test quality, doc sync), reconciles worktrees and evergreen docs, clusters signals, and promotes recurring bugs into static checks | Running a repo health audit, cleaning stale worktrees, or turning repeated issues into rules | "Run a full repo health audit and check for recurring rules to promote" | Read-only audit by default; updates static rules or files governance tasks during retro (`govern-audit.mjs`) |

## Supported Languages

**Any language works.** Language only decides how precisely commands are inferred from package manifests; it never blocks the workflow.

| Situation | How it works |
| --- | --- |
| **Recognized manifests (12)** | `Node.js`, `Python`, `Rust`, `Go`, `Java`, `Ruby`, `PHP`, `.NET`, `C/C++`, `Dart`, `Swift`, and `Elixir` yield idiomatic build, test, and install commands |
| **Any other language** | Haskell, OCaml, Zig, Nim, Crystal, Julia, or an internal DSL: commands are read from what the repo **already runs** in CI `run:` blocks, `Makefile`, `justfile`, or `Taskfile` |
| **Empty folder bootstrap** | `equip.mjs --bootstrap-empty` generates a universal baseline (Git baseline, three-layer docs, `docs/TDD.md`, `AGENTS.md`, and 8 skills) with zero toy business code across 14 presets (12 languages plus `universal` and `docs`, defaulting to `universal`) while preserving `README.md` and `LICENSE` |

Documentation-only repos, editor extensions, Obsidian plugins, and skill folders are also supported. When neither manifests nor CI/task files exist, the survey reports honestly that no command was found and lists where to look instead of guessing.

## Guardrails

Daily operations split into two tiers based on **whether they can be undone**:

| Tier | Actions | Human confirmation |
| --- | --- | --- |
| **Undoable** | Local commits, pushing your own branch, opening or editing a PR, running checks | None; revert or redo anytime |
| **Not undoable** | Merging into the default branch, tagging a release, publishing, changing visibility, rewriting pushed history | Required; actions are listed for approval first |

Two hard rules apply everywhere:

- **Weakening a gate requires human sign-off**: deleting tests, relaxing assertions, adding skip markers, or loosening CI checks must be approved by a person.
- **Force-push is never automatic**: nothing runs `git push --force` or rewrites pushed history on its own.

When an independent review passes with zero open findings, **the reviewer merges directly**.

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
