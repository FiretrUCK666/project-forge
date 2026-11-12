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

It governs; it does not generate the project. It will not pick your stack or write your source.

The survey report ends by listing **which pages, and which sections, this run should read** —
computed from what the survey actually found, not a fixed index.

## How much it does

The survey returns a maturity level, and that sets how heavy this run is:

| Maturity | Meaning | What happens |
| --- | --- | --- |
| `empty` | Nothing there | No governance; let the project exist first |
| `greenfield` | Source but no repo, or no docs | Build it all |
| `partial` | Repo and some docs, with gaps | Fill the gaps, touch nothing that exists |
| `mature` | Everything is there | Inspect only |

The same survey returns `gaps`, which lists **only things that will cause trouble**. A
single-language README, no CONTRIBUTING, no CI — none of those are gaps. Treating preferences
as defects leaves every project owing a debt it can never pay off.

## Before you start

One requirement: **Node.js 18 or newer**. Nothing to install, no build step.

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
# Read-only survey (--markdown gives a human-readable report)
node "<skill-dir>/scripts/survey.mjs" "<project-dir>" --markdown

# Create or refresh AGENTS.md
node "<skill-dir>/scripts/compose-agents.mjs" "<project-dir>"

# Delivery check (--scope limits it to specific faces)
node "<skill-dir>/scripts/review.mjs" "<project-dir>"

# Handoff: see what is left behind (read-only, deletes nothing)
node "<skill-dir>/scripts/handoff.mjs" "<project-dir>" --scan
```

## Why it stays quiet

Three things make up most of how it feels to use:

1. **It does not check harmless preferences.** A single-language README, no CI on a personal
   tool, not publishing — none of those are defects. The only question that matters: **will
   this cause trouble?** Only that blocks.
2. **Decisions live in the project, not in flags.** Choices only you can make ("this project
   ships no LICENSE") go into the `## 取舍` section of `AGENTS.md`. No twelve flags to
   remember, no hidden state file.
3. **Traces are visible.** Everything it leaves behind carries a `project-forge:` marker,
   right in the text. Both people and agents can grep for it, and delete it by hand. One
   command removes it all when you no longer need it.

## What it will not do

- Make your private repo public (private by default; going public needs your explicit word)
- Force-push, rewrite pushed history, or delete a published release
- **Decide on its own that it is time to release**: day to day it stops at push-a-branch +
  open a PR; merging is left to a person, and tagging, release pages, and registry publishes
  all need your explicit word
- Pick a license for you, or invent an identity
- **Remove anything it left behind without your explicit confirmation**

It sorts actions by **whether they can be undone**, not by whether they leave the machine:
pushing your own branch, opening a PR, and editing a PR can all be undone (delete the branch,
close the PR), so they are ordinary work and need nobody's nod. Merging into the default
branch, publishing a release, flipping a private repo public, and rewriting history cannot be
undone — those stop and wait for you. Force-pushing and rewriting pushed history never run
automatically.

**The same rule governs how this skill is maintained.** It governs other projects and it
governs itself: branch → gates green → push the branch → open a PR → a person merges. Not one
more confirmation, not one less independent review.

Daily work and releasing are two different things, and it only does the first by default.
Not out of caution for its own sake: the two differ in whether they can be undone. A wrong
push can be reverted with a follow-up commit; a published version cannot be taken back —
people have already installed it. "Several changes piled up" or "the version number looks
due for a bump" are not reasons to release.

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
  themselves, package boundaries, the release chain) need an independent review round.

## What is inside

```text
SKILL.md            Entry point: which document to read when, and the gate table
references/         Ten sets of criteria, read the one this step needs
templates/          Skeletons that land in the project: contract, docs, releasing, licenses, pipelines
scripts/            Survey, generate, check, hand off, sync table of contents, self-update
```

`scripts/dev/` serves this repository's own self-check only and never ships in the user package.

This repository is the first user of its own rules: the root `AGENTS.md` is generated and
maintained by `compose-agents.mjs`, and `preflight` checks that it stays structurally aligned
with `templates/`. When that fails, the repository is fixed before the rules are.

## License

[MIT](LICENSE)
