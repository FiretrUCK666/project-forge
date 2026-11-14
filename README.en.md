# project-forge

English | [中文](README.md)

Give it a project directory. It surveys the project read-only first, works out what this
project actually needs, then does it: version control, a GitHub remote, the documentation
set, a release channel — plus the protocol for how work lands after that. At the end it asks
whether you want the traces it left behind cleaned up.

No tech stack is assumed. Node, Python, Rust, Go, Java, pure-docs directories, plugin
projects, and capability directories (skills) are all judged from surveyed facts.

## Contents

<!-- toc:start -->

- [What it does](#what-it-does)
- [How much it does](#how-much-it-does)
- [Before you start](#before-you-start)
- [Install](#install)
- [Staying up to date](#staying-up-to-date)
- [Usage](#usage)
- [Why it stays quiet](#why-it-stays-quiet)
- [What it will not do](#what-it-will-not-do)
- [Problems and contributing](#problems-and-contributing)
- [What is inside](#what-is-inside)
- [License](#license)

<!-- toc:end -->

## What it does

Going from "it runs" to "it looks like a real project" is a pile of small, easy-to-get-wrong
things: are the ignore rules right, should build output be committed, is the commit identity
set, do the promises in the README hold, will the release pipeline leak a credential. None is
hard; together they are a lot, and mistakes usually surface much later.

It folds those into four steps:

| Step | What happens |
| --- | --- |
| **S1 Survey** | A read-only scan returns a `maturity` and a list of `gaps` |
| **S2 Scope** | Decide what this run covers, and say it in one sentence |
| **S3 Land** | Repo → docs → remote → automation. Read existing files first, fill only what is missing |
| **S4 Verify and hand off** | Run the project's own gates plus the delivery check, report, ask about cleanup |

It governs and wires up daily engineering workflows rather than inventing arbitrary app code: for zero-file directories it can scaffold a minimal runnable and tested skeleton via `equip.mjs --bootstrap-empty` after a short confirmation; for existing codebases it fills missing contracts, four-layer docs, and built-in dev skills (`kit/skills/` -> `.agents/skills/`).

The survey report ends by listing **which pages, and which sections, this run should read** —
computed from what the survey actually found, not a fixed index.

## How much it does

The survey returns a maturity level, and that sets how heavy this run is:

| Maturity | Meaning | What happens |
| --- | --- | --- |
| `empty` | Nothing there | Ask briefly, bootstrap a minimal runnable + tested skeleton and initial `docs/TDD.md` (`--bootstrap-empty`), then govern |
| `greenfield` | Source but no repo, or no docs | Build it all and equip the full `.agents/skills/` suite |
| `partial` | Repo and some docs, with gaps | Fill the gaps, leave existing or user-edited bytes untouched |
| `mature` | Everything is there | Inspect only, and losslessly refresh untouched managed files via SHA256 ledger |

The same survey returns `gaps`, which lists **only things that will cause trouble**. A
single-language README, no CONTRIBUTING, no CI — none of those are gaps. Treating preferences
as defects leaves every project owing a debt it can never pay off.

## Before you start

One requirement: **verified on Node 18**; newer versions are expected to work but have not
been checked one by one. Nothing to install, no build step, no third-party dependencies.

`git` is optional. Capabilities that need it report honestly and skip; they never pretend to
have succeeded.

## Install

Unpack into **your host's user-level skill root**. If you already have other skills installed,
put it beside them; if not, check your host's documentation. Keep the directory name
`project-forge` — it must match `name` in the `SKILL.md` frontmatter, and on a case-sensitive
filesystem a different case is a different directory.

No registration or restart: the host discovers it by directory, and `SKILL.md` is the entry.

Two ways to get it, pick one:

| How | What you get | How you learn about a new version | Good for |
| --- | --- | --- | --- |
| **Download the release archive** | A standalone copy with no `.git` | It checks by itself (see the next section) | Just using it |
| **Clone this repository** | Full history and commits | `git pull`; the tool never touches it | Reading changes, contributing, modifying it |

The criterion is one thing: **is there a `.git` directory**. If yes it is a source copy, and
`update.mjs` treats it as read-only. If no it is a package copy, and `update.mjs` replaces it
wholesale. That judgement needs no memory and no guessing at intent.

## Staying up to date

Nothing to do after installing: each run checks the remote once first (throttled — no repeated
request within an hour) and swaps in a newer version if there is one.

To ask for a check on demand, outside the throttle:

```sh
node "<skill-dir>/scripts/update.mjs" --check
```

If your host forbids skills from modifying themselves (read-only sandbox, audit rules), or you
simply do not want the install directory touched this time, one environment variable turns it
off completely:

```sh
# any non-empty value works
export PF_NO_UPDATE=1
```

Updating is **a wholesale replacement**: it does not ask, compare, or look at local edits — the
whole point of a package copy is "the latest version when you use it". Conversely, if you have
edited that copy, do not let it update; or switch to a clone, which the tool treats as
read-only.

## Usage

Just talk to it in plain language. You do not need to name it:

```text
Clean this project up for me
Give this project a GitHub remote and CI
Check for leaked credentials and write me an AGENTS.md
```

Name one thing and it does only that thing.

It prints a few commands; `<skill-dir>` is where this skill lives and `<project-dir>` is the
project being worked on:

```sh
# Read-only survey (--markdown for human report, --probe-auth for dual-track GitHub probe)
node "<skill-dir>/scripts/survey.mjs" "<project-dir>" --markdown

# Equip or losslessly refresh the 5 built-in dev skills (--bootstrap-empty / --check / pre-write backup)
node "<skill-dir>/scripts/equip.mjs" "<project-dir>"

# Manage off-repo pre-write .tar.gz snapshots (auto-created before equip / compose-agents edits, max 5 kept)
node "<skill-dir>/scripts/backup.mjs" list "<project-dir>"

# Create or refresh AGENTS.md (<= 30KB budget + SHA256 lossless region protection)
node "<skill-dir>/scripts/compose-agents.mjs" "<project-dir>"

# Delivery check (--scope limits it to specific faces)
node "<skill-dir>/scripts/review.mjs" "<project-dir>"

# Handoff: see what is left behind (read-only, deletes nothing)
node "<skill-dir>/scripts/handoff.mjs" "<project-dir>" --scan
```

Once equipped, `.agents/skills/` provides five self-contained dev skills guided by the top routing table and core operating principles (`行事总纲`) in `AGENTS.md`:

- **Built-in Dev Suite (`kit/skills/` -> `.agents/skills/`)**:
  - `dev-explore` (`repo-map.mjs`): `quick` / `medium` / `thorough` read-only exploration extracting `ciRunSteps`, `reusableModules`, and `featureMap` to prevent human-proxy guessing;
  - `dev-plan` (`doc-plan.mjs`): 5-tier triage (`Case 1`..`Case 5`), `two-way`/`one-way` door classification, self-purifying `audit`, and tiered independent `critique-pass` lock;
  - `dev-flow` (`flow.mjs`, `worktree-deps.mjs`): task ledger, zero-copy Junction/Symlink shared dependencies with `unlinkSync`-before-remove protection, 4-state worktree checks, `verify --mode smoke`, and exit-code `4` blocking when `merge` detects gate weakening;
  - `dev-review` (`review-pack.mjs`): external PR `--untrusted-scan` poison gate, `behavioralGate` (including `smoke-verify`) + `structuralGate` (tombstone/excuse comments, god files, and `arch-rules`) + `doorAssessment` dual gates, and 6-lock stop-loss review loop;
  - `dev-govern` (`govern-audit.mjs`): 8 audit upgrades (evolution churn, fence-aware dead-link checks, commented dead code & excuse/tombstone scans, god-file warnings, `arch-rules`, orphan tests, 4-state worktree detection) plus `record`, `cluster`, and `sample`.
- **Four-Layer Docs and Pre-Write Snapshots**: `AGENTS.md` (entry contract, 30KB hard cap / 24KB warn, 7-key `Dev Profile`: `quick-test`, `full-test`, `smoke-verify`, `merge-gate`, `arch-rules`, `high-risk`, `do-not-edit`) + `docs/TDD.md` (evergreen architecture and `Feature Map`) + `docs/prd/` + `docs/specs/` and `docs/todo/` (archived into `docs/archive/todo/` before merge). `scripts/backup.mjs` automatically stores rolling `.tar.gz` off-repo snapshots before modifying non-empty files (zero `git status` pollution, `--no-backup` to skip, `restore` reverts files and removes orphan additions).
- **2-Axis 5-State Identity and Dual-Track 4-Tier GitHub Engine**: distinguishes `local-only`, `maintainer`, `contributor-fork`, `clone-readonly`, and `undetermined` (preventing clones of someone else's repo from being misclassified as maintainer); Transport Track probes SSH (22/443) and HTTPS credential helper with exact protocol-mismatch `remediationCmd`, while API Track degrades cleanly across `gh-cli` -> `node-https-token` -> `mcp-delegate` -> `half-duplex` / `offline` without interactive prompts or token leaks.

## Why it stays quiet

Three things make up most of how it feels to use:

1. **It does not check harmless preferences.** A single-language README, no CI on a personal
   tool, local-only repos without a remote — none of those are defects. The only question that
   matters: **will this cause trouble?** Only that blocks.
2. **Decisions live in the project, not in flags.** Choices only you can make ("this project
   ships no LICENSE") go into the `## 取舍` section of `AGENTS.md`. No twelve flags to
   remember, no hidden state file.
3. **Traces are visible and customizations stay safe.** `AGENTS.md` carries `project-forge:` markers,
   and `.agents/skills/.pf-manifest.json` tracks SHA256 hashes for both kit files and managed
   `AGENTS.md` regions: untouched files upgrade cleanly, retired files self-clean automatically,
   and user-modified files or custom skills stay 100% untouched. One command scans or removes traces on handoff.

## What it will not do

- Make your private repo public (private by default; going public needs your explicit word)
- Force-push, rewrite pushed history, or delete a published release
- Misclassify a read-only clone as maintainer, merge an upstream PR on behalf of a `contributor-fork`, or delete its branch while the PR is still open
- Execute external PR workflows or lifecycle scripts without explicit human approval (statically blocked by `--untrusted-scan`)
- **Decide on its own that it is time to release**: day to day it stops at push-a-branch +
  open a PR → independent review → merge; tagging, release pages, and registry publishes all
  need your explicit word
- Pick a license for you, or invent an identity
- **Remove anything it left behind without your explicit confirmation**

It sorts actions by **whether they can be undone**, not by whether they leave the machine:
pushing your own branch, opening a PR, and editing a PR can all be undone (delete the branch,
close the PR), so they are ordinary work and need nobody's nod. Publishing a release, flipping
a private repo public, and rewriting history cannot be undone — those stop and wait for you.
Force-pushing and rewriting pushed history never run automatically.

**The reviewer finishes the merge.** Once the independent review passes, that same reviewer
merges — it is not handed back to a person for one more click. People do not read the code; a
merge gate in human hands becomes a rubber stamp that adds waiting and no judgement. The
judgement already happened in the review, which had the frozen acceptance criteria, the diff,
the raw gate output, and a fault injection. Proposals from outside contributors work the same
way; the protection against strangers sits **before** the review (read the diff first, disable
lifecycle scripts when running gates).

**Only one class needs a human nod: weakening a gate.** Deleting tests, relaxing assertions,
adding skip markers, turning a check into a warning, loosening CI — `flow.mjs merge`
blocks detected gate-weakening diffs with exit code `4` unless explicitly approved with
`--human-approved`. Want to be more conservative? Write `merge-authority: human` in the
project's `AGENTS.md` under `## 取舍`.

**The same rule governs how this skill is maintained.** It governs other projects and it
governs itself: branch → gates green → push the branch → open a PR → independent review →
merge. Not one more confirmation, not one less review.

Daily work and releasing are two different things, and it only does the first by default.
Not out of caution for its own sake: the two differ in whether they can be undone. A wrong
push can be reverted with a follow-up commit; a published version cannot be taken back —
people have already installed it. "Several changes piled up" or "the version number looks
due for a bump" are not reasons to release.

**It always asks before clearing traces.** Branches, worktrees and remote branches belong to
someone's machine, and deleting them cannot be undone. It lists exactly what would go (which
worktree, which local branch, which remote branch) and waits for your word. When it cannot reach
you, that list goes into the report and nothing is deleted — no answer is not consent.

## Problems and contributing

- **Report a defect** with the repository's [bug template](.github/ISSUE_TEMPLATE/bug_report.md).
  It asks exactly the four things that make a report locatable — expected, actual, how to
  reproduce, on what environment. Miss any one and a round trip is guaranteed. If the problem
  is about a survey judgement, include the surveyed directory's stack and rough structure; that
  usually points straight at the criterion that missed something.
- **Ask for a capability, or argue a judgement should differ**, with the
  [feature template](.github/ISSUE_TEMPLATE/feature_request.md).
- **Change code**: see [CONTRIBUTING](CONTRIBUTING.md) — how to run it locally, which gates
  there are, and how to submit a change. Changes on high-risk paths (judgement logic, the gates
  themselves, package boundaries, the release chain) need an independent review round, and that
  review reports per acceptance criterion frozen before the work started — see
  the "Seven, the review loop" section of `references/collaboration.md` for the criteria and the stop rules.

## What is inside

```text
SKILL.md            Entry point: which document to read when, and the gate table
references/         Criteria pages, read the one this step needs
templates/          Skeletons that land in the project: AGENTS contract, 4-layer docs, contributing/releasing, licenses, pipelines
kit/skills/         Five self-contained built-in dev skills shipped with the package (dev-explore/plan/flow/review/govern)
scripts/            Survey, equip, backup, compose-agents, review, handoff, sync-toc, self-update
```

`scripts/dev/`, `.agents/`, and `docs/` serve this repository's own self-checks, dogfooding, and records only, and are excluded from the user archive via `.gitattributes`.

This repository is the first user of its own rules: root `.agents/skills/` is synced from single-source `kit/skills/` via `equip.mjs .`, and root `AGENTS.md` is generated by `compose-agents.mjs .` and checked for structural alignment by `preflight`. When that fails, the repository is fixed before the rules are.

## License

[MIT](LICENSE)
