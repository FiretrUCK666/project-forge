<p align="center">
  <img src="assets/readme/hero-en.svg" alt="project-forge overview" width="100%">
</p>

<p align="center">
  <strong>English</strong> · <a href="README.md">简体中文</a>
</p>

**project-forge** is a zero-dependency Node 18+ governance and AI-collaboration foundation kit for GitHub repositories. It enforces **read-only survey first, pre-write snapshots, lossless merging for existing conventions, and empirical verification**. Whether bootstrapping an empty directory, onboarding a heterogeneous legacy repository, or recalibrating a codebase months later, the same idempotent pipeline equips version-control discipline, GitHub remote and CI automation, a four-layer documentation model, a bounded `AGENTS.md` contract, and five local dev skills.

## Contents

<!-- toc:start -->

- [Why project-forge](#why-project-forge)
- [How the Four-Step Workflow Works](#how-the-four-step-workflow-works)
- [Architecture and Local Dev Skills](#architecture-and-local-dev-skills)
- [Three Onboarding Scenarios](#three-onboarding-scenarios)
- [Install and Quick Start](#install-and-quick-start)
- [Daily Collaboration and Release Flow](#daily-collaboration-and-release-flow)
- [Core Scripts Reference](#core-scripts-reference)
- [Requirements, Boundaries, and License](#requirements-boundaries-and-license)

<!-- toc:end -->

## Why project-forge

Engineering governance rarely fails from a lack of templates. It fails when templates overwrite working conventions, docs drift away from scripts, and every fresh AI session has to re-discover project rules. `project-forge` targets four concrete failure modes:

- **Closed-loop empty directory start**: For five stacks (`node`, `python`, `go`, `rust`, `docs`), `--bootstrap-empty` generates `.gitattributes`, `.gitignore`, `README.md`, runnable code with working tests, and structured `docs/TDD.md` from day one.
- **Lossless merge for heterogeneous repos**: `survey.mjs` inspects Git, docs, CI, licensing, and existing local skills without touching disk, emitting a 10-item `artifactPlan`. Compliant files stay intact, and custom `README.md`, `CONTRIBUTING.md`, `LICENSE`, or homegrown skills are preserved rather than blindly overwritten.
- **Cross-month drift calibration**: Re-run `survey.mjs`, `compose-agents.mjs --upgrade`, and `review.mjs` at any later date to upgrade managed contract sections, verify checksums, and detect script-to-doc drift without erasing maintainer trade-off notes.
- **Empirical loop without human-proxy claims**: Claims follow a strict Trust Inverted Pyramid where executable static gates, runtime smoke checks, and independent dual-gate reviews outrank prose contracts.

## How the Four-Step Workflow Works

<p align="center">
  <img src="assets/readme/workflow-en.svg" alt="project-forge four-step idempotent workflow showing empty directory, existing repo merge, and monthly calibration converging into S1 through S4" width="100%">
</p>

All three entry paths feed into the same repeatable four-step engine, where a second run produces byte-identical outputs:

1. **S1 Read-only Survey**: Run `survey.mjs --probe-auth` to classify repository state and compute the 10-item `artifactPlan` (`keep`, `add`, `upgrade`, `skip`) without modifying any target file.
2. **S2 Scope Decisions**: Confirm only undecided maintainer choices (license, repository visibility, contributor templates, CI preferences) rather than prompting over facts already present on disk.
3. **S3 Snapshot and Ordered Apply**: Capture a `.tar.gz` pre-write snapshot via `backup.mjs`, then apply changes strictly in **Repo → docs → remote → automation** order while equipping local skills and managed `AGENTS.md`.
4. **S4 Empirical Review and Handoff**: Run `review.mjs` across all 10 verification scopes, check temporary traces with `handoff.mjs`, and ask the maintainer before cleaning up any reversible workspace state.

## Architecture and Local Dev Skills

<p align="center">
  <img src="assets/readme/architecture-en.svg" alt="project-forge dual-layer architecture showing the governance foundation above five local dev skills and the trust inverted pyramid" width="100%">
</p>

The governance foundation maintains repository boundaries, backups, a capped `AGENTS.md <= 30KB` contract, and four-layer design docs (`docs/TDD.md` architecture contracts, `docs/prd/` product goals, `docs/specs/` change specs, and `docs/todo/` work tracking). Daily engineering execution is handled inside the target repo under `.agents/skills/` (integrity-tracked in `.pf-manifest.json`) by five local dev skills:

| Local Skill | Primary Script | Responsibility and Output |
| --- | --- | --- |
| `dev-explore` | `repo-map.mjs` | Three-depth (`quick`/`medium`/`thorough`) read-only repo map and change impact analysis |
| `dev-plan` | `doc-plan.mjs` | Three-tier triage across the four-layer doc model (drafted by AI, approved by maintainer) |
| `dev-flow` | `flow.mjs` | Worktree-isolated task flow: branch, claim, verify, submit PR, rework, merge, cleanup |
| `dev-review` | `review-pack.mjs` | Isolated review pack with fault injection and untrusted external PR static pre-scan |
| `dev-govern` | `govern-audit.mjs` | Code-to-doc drift audit and `release-prep` multi-version release readiness verification |

Every verification claim follows the **Trust Inverted Pyramid** from strongest to weakest: `1. Static gates` > `2. Runtime smoke` > `3. Dual-gate review` > `4. Contract docs`.

## Three Onboarding Scenarios

| Scenario | Starting State | `project-forge` Strategy | Entry Command |
| --- | --- | --- | --- |
| **Empty directory start** | Blank folder or empty workspace | `--bootstrap-empty` scaffolds source, runnable tests, ignore rules, and design docs for 5 stacks | `node "<skill-dir>/scripts/equip.mjs" "<repo>" --bootstrap-empty --lang node --name my-app` |
| **Existing repo merge** | Active codebase with existing README, LICENSE, or custom skills | Read-only `artifactPlan` keeps healthy assets intact and adds only missing gates and local skills | `node "<skill-dir>/scripts/survey.mjs" "<repo>" --markdown --probe-auth` |
| **Monthly calibration** | Previously forged repo after months of feature drift | Upgrades managed contract blocks idempotently, checks `.pf-manifest.json`, and audits drift | `node "<skill-dir>/scripts/compose-agents.mjs" "<repo>" --upgrade` |

## Install and Quick Start

`project-forge` uses only **Node.js 18+** built-ins and **Git**, with zero third-party runtime dependencies and zero AI-host lock-in:

```sh
git clone <project-forge-repo-url> project-forge
```

Run the standard four-step onboarding sequence against any repository:

```sh
# 1. Read-only survey with 10-item artifactPlan and GitHub auth probe
node "<skill-dir>/scripts/survey.mjs" "<project-dir>" --markdown --probe-auth

# 2. Create a pre-write .tar.gz safety snapshot before making edits
node "<skill-dir>/scripts/backup.mjs" create "<project-dir>" --label pre-forge

# 3. Equip the 5 local dev skills and compose/upgrade managed AGENTS.md
node "<skill-dir>/scripts/equip.mjs" "<project-dir>"
node "<skill-dir>/scripts/compose-agents.mjs" "<project-dir>"

# 4. Run 10-scope delivery review and verify clean handoff traces
node "<skill-dir>/scripts/review.mjs" "<project-dir>"
node "<skill-dir>/scripts/handoff.mjs" "<project-dir>" --verify
```

Prompting an AI assistant works with a single direct instruction: `Use project-forge to inspect this repository's governance, GitHub workflow, and local dev skills; survey read-only first and fill only verified gaps.`

Check for upstream skill updates with `node "<skill-dir>/scripts/update.mjs" --check`, or disable network checks cleanly in offline environments with `PF_NO_UPDATE=1`.

## Daily Collaboration and Release Flow

Daily delivery tiers are divided strictly by **whether they can be undone**, never by guesswork:

- **Daily actions (reversible)**: Edit locally → pass all gates → commit → **pushing your own branch** → open a Pull Request → independent review. Branches and PRs can be deleted or closed without harm.
- **Reviewer closes the loop**: When an independent reviewer confirms `fail` is empty with fault-injection evidence against frozen acceptance criteria, the **reviewer merges directly** (unless the maintainer explicitly sets a stricter policy in `AGENTS.md`).
- **Human nod required**: **Weakening a gate** (deleting tests, relaxing assertions, adding skip markers, downgrading CI failures to warnings) masks future regressions and always stops for explicit human approval. Merging without review policy, publishing releases, changing repo visibility, and rewriting pushed history never happen automatically.

When a maintainer explicitly requests a release (including multi-version jumps or custom version targets), verify the commit range and public-surface impact first, then follow [RELEASING.md](RELEASING.md) by committing release notes to the default branch before pushing the tag and reading back the live release page:

```sh
node .agents/skills/dev-govern/scripts/govern-audit.mjs release-prep --from v4.0.0 --to HEAD --version v5.0.0
```

## Core Scripts Reference

| Script | Key Flags | Purpose |
| --- | --- | --- |
| [scripts/survey.mjs](scripts/survey.mjs) | `--markdown`, `--probe-auth` | Read-only repo classification, GitHub auth probe, and 10-item `artifactPlan` |
| [scripts/backup.mjs](scripts/backup.mjs) | `create\|list\|restore`, `--label`, `--id`, `--dry-run`, `--json` | Create, inspect, and restore pre-write `.tar.gz` snapshots |
| [scripts/equip.mjs](scripts/equip.mjs) | `--check`, `--dry-run`, `--bootstrap-empty --lang ... --name ...` | Install or verify the 5 local dev skills, or bootstrap an empty project |
| [scripts/compose-agents.mjs](scripts/compose-agents.mjs) | `--status`, `--upgrade`, `--check`, `--clean` | Idempotently compose/upgrade managed `AGENTS.md` under the 30KB cap |
| [scripts/review.mjs](scripts/review.mjs) | `--scope=...`, `--strict`, `--json` | 10-scope pre-delivery governance and evidence check |
| [scripts/handoff.mjs](scripts/handoff.mjs) | `--scan`, `--verify`, `--json` | Detect and verify removal of temporary forge traces |
| [scripts/sync-toc.mjs](scripts/sync-toc.mjs) | `--check`, `--max-level`, `--min-sections` | Generate and verify synchronized Markdown TOC blocks |
| [scripts/update.mjs](scripts/update.mjs) | `--check`, `--quiet`, `--equip <dir>` | Check and apply upstream `project-forge` skill updates |

## Requirements, Boundaries, and License

- **Runtime**: Node.js 18+ (`scripts/` uses `node:` built-ins exclusively with zero third-party dependencies) and Git; GitHub CLI (`gh`) or configured GitHub credentials are required when automating remote setup and branch protections.
- **Scope boundaries**: `project-forge` governs engineering workflows, contracts, docs, and verification gates—it **does not generate application business logic or pick tech stacks**, and its product layer targets GitHub exclusively.
- **Further reading**: Orchestration entry and gate matrix in [SKILL.md](SKILL.md), repository contract in [AGENTS.md](AGENTS.md), contributor workflow in [CONTRIBUTING.md](CONTRIBUTING.md), and release runbook in [RELEASING.md](RELEASING.md).
- **License**: Released under the [MIT License](LICENSE).
