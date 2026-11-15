<p align="center">
  <img src="assets/readme/hero-en.svg" alt="project-forge workflow diagram: turning a loose folder into a documented GitHub repository" width="100%">
</p>

<p align="center">
  <a href="README.md">简体中文</a> | <strong>English</strong>
</p>

<p align="center">
  <a href="RELEASING.md"><img src="https://img.shields.io/badge/version-v6.0.0-4E7496?style=flat-square" alt="Version v6.0.0"></a>
  <a href="#install"><img src="https://img.shields.io/badge/node-%3E%3D18-1F6F5B?style=flat-square" alt="Node.js 18 or newer"></a>
  <a href="SKILL.md"><img src="https://img.shields.io/badge/dependencies-0-1F6F5B?style=flat-square" alt="Zero third-party dependencies"></a>
  <a href="#the-five-everyday-skills"><img src="https://img.shields.io/badge/kit-5%20skills-D96B27?style=flat-square" alt="Five bundled local dev skills"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-526075?style=flat-square" alt="MIT License"></a>
</p>

A brand-new folder, or a repository that has been maintained for months, usually costs the most time outside the product code itself: `.gitignore` misses local secrets, design notes drift away from the implementation, branches land without real test output, and editing one file gives no warning about the other four that must change with it.

**project-forge** surveys a folder read-only first, then fills in the Git baseline, the four-layer design docs, the `AGENTS.md` contract, GitHub check workflows, and five local development skills, sized to the project. It never overwrites what you wrote by hand, and it installs no third-party dependencies, so Node.js 18 or newer is all you need.

## What It Does

- **Existing repositories keep their handwritten content**: your `README.md`, `CONTRIBUTING.md`, architecture docs, CI workflows, and custom local skills stay exactly as they are. Before writing any file into a non-empty repository, a `.tar.gz` snapshot is saved outside the repository.
- **PRDs, specs, and task lists travel with the branch**: the three doc folders `docs/prd/`, `docs/specs/`, and `docs/todo/` use the same YAML frontmatter and `YYMMDD-issue<N>-<slug>-{prd,spec,todo}.md` naming, and `flow.mjs finalize` archives them together into `docs/archive/` when the work is done.
- **Nothing merges on self-reported code reading**: a change needs passing static gates, real command output, and an independent-context review. Mermaid diagram widths and document anchors are checked before every commit.
- **Editing one side warns about the other**: a dependency table inside `AGENTS.md` records which templates and docs must be checked when source changes, and which source entry points to verify when docs change.
- **Two tiers, lossless upgrade at any time**: a small personal repository can stay on `lightweight` (a `< 14KB` contract plus three core skills) and move to all five later with `--tier full`. Files you deleted or edited by hand are recorded in `.pf-manifest.json` and never written back.

## Contents

<!-- toc:start -->

- [What It Does](#what-it-does)
- [One Real Change, End to End](#one-real-change-end-to-end)
- [The Five Everyday Skills](#the-five-everyday-skills)
- [Supported Languages](#supported-languages)
- [Install](#install)
- [What the First Run Does](#what-the-first-run-does)
- [Automatic Updates](#automatic-updates)
- [Guardrails](#guardrails)
- [Script Reference](#script-reference)
- [License](#license)

<!-- toc:end -->

## One Real Change, End to End

<p align="center">
  <img src="assets/readme/workflow-en.svg" alt="Onboarding convergence flow from three repository starting points into four setup steps" width="100%">
</p>

After setup, this is the chain you will walk most days. Suppose you want to add a "export to CSV" feature:

| Step | What you say | Which skill runs | What you get |
| --- | --- | --- | --- |
| 1 | "Show me where the export module lives and which commands verify it" | `dev-explore` | Module entry points and a verification command list. Read-only, nothing is modified |
| 2 | "Write a plan for CSV export with checkable criteria" | `dev-plan` | One SPEC and one Todo, with acceptance criteria numbered `C1`, `C2` |
| 3 | "Start on that plan" | `dev-flow` | An isolated branch or worktree, verification bound to this commit, pushed and opened as a PR |
| 4 | "Review this PR from an independent angle" | `dev-review` | A per-criterion verdict against `C1` and `C2`, written back to both the PR and the issue |
| 5 | "Merge if it passes, then clean up" | `dev-flow` | Merge, remove the worktree, delete the local branch, read back to confirm |

**What you can skip:**

- Fixing a typo or adjusting one line of formatting needs neither step 1 nor step 2. Just make the change and run the relevant check.
- When the requirement is already unambiguous and touches a single file, step 2 can be skipped, but the independent review in step 4 cannot.
- When a change touches critical paths such as `scripts/lib/`, `templates/`, or `SKILL.md`, step 4 must run in a separate independent context. Reviewing your own work is not review.

**Why the order is what it is:** surveying before planning keeps invented paths out of the plan; freezing the criteria up front gives the review a shared ruler; separating implementation and review into different contexts prevents "I remember changing that" from hiding a regression.

## The Five Everyday Skills

`lightweight` installs the first three; `full` installs all five. You never type commands in daily use: describe what you want, and `AGENTS.md` routes it to the right skill.

| Skill | When to reach for it | What it does |
| --- | --- | --- |
| `dev-explore` | You are new to the repository, or need to confirm a module's entry points and verify commands | Read-only scan of source structure, multi-package entry points, test and build commands. Modifies nothing |
| `dev-plan` | You need a plan, a task breakdown, or a judgment call on how much process this change deserves | Decides whether this is a small fix or a cross-module change, then generates `docs/prd/`, `docs/specs/`, and `docs/todo/` as needed, checking diagram widths and dead links |
| `dev-flow` | You are about to change code, take an issue, commit, open a PR, merge, or clean up a worktree | Creates an isolated branch or worktree, claims the issue, runs verification, pushes and opens the PR, reworks after review, and finishes the merge |
| `dev-review` | You want an independent review, or you received an external PR | Reviews against the frozen criteria in a separate context and runs a supply-chain scan on untrusted PRs first |
| `dev-govern` | Routine health checks, technical debt, documentation drift, or release notes | Audits dead code, stale docs, weak tests, and slow tests, and assembles the change list for a release |

**How they connect:** `dev-explore` establishes the facts, `dev-plan` turns those facts into checkable criteria, `dev-flow` implements and verifies in isolation, `dev-review` judges with a second pair of eyes, and `dev-flow` closes out. `dev-govern` sits off the main chain: you run it on a maintenance schedule, and its findings usually become the input to the next `dev-plan` round.

## Supported Languages

These are two different capabilities with different coverage, so they are stated separately.

**Detected languages (12).** Point the tool at an existing project and the survey identifies which one it is, supplies the matching build, test, and install commands, and generates `docs/TDD.md` and `AGENTS.md` from those facts:

`Node.js`, `Python`, `Rust`, `Go`, `Java`, `Ruby`, `PHP`, `.NET`, `C/C++`, `Dart`, `Swift`, `Elixir`

Documentation-only folders, editor extensions, Obsidian plugins, and capability directories are also supported.

**Languages with a starter scaffold (6).** When the folder is completely empty, `--bootstrap-empty --lang` can lay down a minimal project that passes its own smoke test, together with an initial `docs/TDD.md`:

`node`, `python`, `go`, `rust`, `java`, `docs`

For any other language, create the project with your own generator first and then run the survey. Everything downstream is identical.

## Install

**Requirements**: `Windows`, `macOS`, or `Linux`, with `Node.js 18` (`>= 18`) or newer. Every script uses only built-in Node modules, so there is no `npm install` step.

**Option 1: download the archive (recommended for everyday use)**

Get the latest `project-forge.zip` from the [Releases page](https://github.com/FiretrUCK666/project-forge/releases), or use this direct link:

```text
https://github.com/FiretrUCK666/project-forge/releases/latest/download/project-forge.zip
```

Unzip it, **keep the folder named `project-forge`**, and place the whole folder in your host's skills directory.

Do not add a version suffix such as `project-forge-v6`. The host compares the folder name with the skill name and silently skips loading it when they differ.

**Option 2: `git clone` (for people changing the tool itself)**

```sh
git clone https://github.com/FiretrUCK666/project-forge.git
```

This is a source copy with a `.git` directory. It does not update itself; run `git pull` yourself.

**Once it is installed**, open the project folder you want to organize and say:

```text
Survey the current folder first and list what is missing and how you would organize it.
```

If the folder is empty, it asks three or four questions (language stack, project description, license, whether to create a remote) and lays down the scaffold. If the folder already has content, it inventories everything read-only, marks your handwritten docs and non-standard directories for preservation, and then tells you what to add.

## What the First Run Does

An empty folder, a half-configured side project, and an active team repository all follow the same sequence:

1. **Read-only survey**: inventories the directory structure, language ecosystems, Git remotes, local credentials, and any existing architecture docs. This step writes nothing.
2. **Scope from observed facts**: handwritten docs and custom skills are always preserved, missing items are filled in, and `lightweight` or `full` is recommended from the project's size. License, repository visibility, and release strategy are questions for you.
3. **Snapshot, then write in order**: a non-empty repository gets an external snapshot first, then files are written in the order **Repo → docs → remote → automation**. That order is not adjustable: `.gitattributes` and `.gitignore` must exist before the first commit, docs and remote addresses must be ready before the first push, and the commands CI runs must match exactly what `AGENTS.md` and `README.md` tell people to type.
4. **Check up and hand off**: a delivery check verifies document links and contract consistency; if the project is going back to manual maintenance, the scaffold markers to be removed are listed for confirmation first.

## Automatic Updates

Only the **archive copy** updates automatically. A `git clone` copy does not: the script will tell you a new version exists, and you run `git pull` yourself.

The archive copy quietly checks for a new version each time it enters a workflow. Here is when it checks, what it does, and how to turn it off.

**When it checks**

- At most once every **1 hour** after a successful check. Using the tool repeatedly in a short window does not mean repeated network calls.
- After a failed check, it waits **15 minutes** before retrying, so working offline never stalls on the network.
- For **24 hours** after a completed update it does not check again, avoiding back-to-back updates.

**What happens when a new version is found**

The archive is downloaded into a temporary directory on the same disk and unpacked, and only after validation does replacement begin. Supporting files are written first and `SKILL.md` is written last, atomically. If the process is interrupted partway through, it rolls back to the pre-update state rather than leaving a half-updated copy.

**How to control it**

```sh
# Check once right now; report only, never modifies files
node "<skill directory>/scripts/update.mjs" --check

# Turn automatic checking off entirely
PF_NO_UPDATE=1

# Point at a different update source, such as an internal mirror
PF_UPDATE_SOURCE="https://github.com/<owner>/project-forge"
```

## Guardrails

Daily operations split into two groups, and whether they can be undone is the only line between them.

- **Undoable, so it is routine**: committing, pushing your own branch, opening or editing a PR, running checks. All of it can be reverted or redone without extra confirmation.
- **Not undoable, so it needs a human first**: merging into the default branch, tagging a release, publishing a version, changing repository visibility, rewriting pushed history. None of it has a way back, so the actions are listed for a person to approve before anything runs.
- **The reviewer merges what passes**: once an independent review passes with no open items, the person who reviewed merges directly instead of handing it off again. A reviewer is the gate, not an advisor.

Two more hard rules:

- **Weakening a gate requires human sign-off**: deleting tests, relaxing assertions, adding skip markers, or loosening CI strictness means a gate will check one less thing from then on. That needs explicit approval.
- **Force-push is never automatic**: nothing here runs `git push --force` or rewrites pushed history on its own.

## Script Reference

Daily use is routed by `AGENTS.md`, so you never need these commands. They are here for manual troubleshooting or wiring the checks into CI.

<details>
<summary>Show the underlying scripts and their responsibilities</summary>

| Script | Purpose |
| --- | --- |
| `node scripts/survey.mjs <dir>` | Read-only inventory of structure, docs, remote topology, auth status, and recommended tier |
| `node scripts/backup.mjs create <dir>` | Create an incremental compressed snapshot outside the repository, protecting the pre-forge baseline |
| `node scripts/equip.mjs <dir> [--tier lightweight\|full]` | Install or losslessly upgrade `.agents/skills/` (supports `--check`, `--adopt-custom`, and `--restore`) |
| `node scripts/compose-agents.mjs <dir> [--tier lightweight\|full]` | Generate or losslessly refresh `AGENTS.md` (`lightweight < 14KB`, `full <= 30KB`) |
| `node scripts/review.mjs <dir>` | Delivery check: contract completeness and claim verification |
| `node scripts/handoff.mjs <dir>` | Remove scaffold markers and temporary leftovers so the project can be handed off |
| `node scripts/sync-toc.mjs README.md README.en.md` | Keep the bilingual README tables of contents in sync |
| `node scripts/update.mjs [--check]` | Check for and atomically apply updates to the archive copy |

</details>

## License

This project is released under the [MIT](LICENSE) license. See [CONTRIBUTING.md](CONTRIBUTING.md) and [RELEASING.md](RELEASING.md) for details.
