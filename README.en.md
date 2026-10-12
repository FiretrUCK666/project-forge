# project-forge

[中文](README.md) | English

[![stars](https://img.shields.io/github/stars/FiretrUCK666/project-forge)](https://github.com/FiretrUCK666/project-forge)
[![license](https://img.shields.io/github/license/FiretrUCK666/project-forge)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A516-339933)](README.en.md#requirements)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](README.en.md#requirements)

Forge any project directory into a well-formed project: version control, remote repository, documentation set, and release channel, all in one pass.

Give it a directory. It first surveys read-only to see what the project currently is, then decides on its own what to do and what to skip. It assumes no stack — Node, Python, Rust, Go, Java, docs-only directories, plugin projects, and skill projects are all judged from surveyed facts.

![project-forge: give it a project directory; it surveys read-only first, then decides from facts what to do. The image also lists the four things it does — version control, docs, remote, release — and the package layout](assets/readme/hero.svg)

## Contents

<!-- toc:start -->

- [What problem it solves](#what-problem-it-solves)
- [How it works](#how-it-works)
- [Install](#install)
- [Update](#update)
- [Usage](#usage)
- [What it will not do](#what-it-will-not-do)
- [What is inside](#what-is-inside)
- [Scripts](#scripts)
- [Design principles](#design-principles)
- [Requirements](#requirements)
- [How this repo itself is set up](#how-this-repo-itself-is-set-up)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

<!-- toc:end -->

## What problem it solves

There is a pile of small but error-prone chores between "it runs" and "it looks like a real project": ignore rules, whether build outputs belong in the repo, commit identity, whether the README promises things that actually hold, whether the release flow could leak a secret. Each one is easy; together they are many, and **mistakes often surface long after they are made**.

project-forge converges them into one flow and writes down the rationale — so it knows not just "what to do", but "why" and "when not to".

## How it works

Four steps, and the order matters:

1. **Survey** (read-only). Read the project's manifest files, directory layout, version-control config, and existing docs, and produce facts. Nothing is written in this step — decisions rest on facts, not on guesses;
2. **Decide.** Feed the facts through the capability matrix, work out what to do this time and what to skip, and tell you the conclusion;
3. **Gate.** Before touching anything you must read the matching criteria: creating a repo, writing docs, and releasing each have their own threshold. Skipping a gate means working from guesswork;
4. **Write.** Write files, create the remote, push, release — then read back to confirm.

![project-forge's chain: read-only survey, decide from facts, pass the hard gates, write and release](assets/readme/pipeline.svg)

The input is **surveyed facts**, not a preset checklist. So it will not bolt a release flow onto a docs-only directory, and it will not recreate a repo that already has a remote — "not releasing" and "skipping something" are normal outcomes, not failures.

## Install

Two ways. Pick one.

### Clone (updates itself)

```sh
git clone https://github.com/FiretrUCK666/project-forge.git "<your skill root>/project-forge"
```

### Zip (no git needed)

Download the latest `project-forge-<version>.zip` from [Releases](https://github.com/FiretrUCK666/project-forge/releases) and unzip it into your skill root, keeping the directory name `project-forge`.

This install **cannot update itself** — the copy has no version history to compare against. When a new version lands, download it and overwrite.

### Where to put it

Drop it into **your host's user-level skill root**:

- **You already have other skills** → put it where they live. That is the most reliable signal; no path to memorize.
- **You have none** → check that host's docs for the location.

Keep the directory name `project-forge` — it must match the frontmatter `name`. **Mind the case**: on case-sensitive systems a different case is a different directory.

No registration or restart is needed: hosts discover by directory, and `SKILL.md` is the entry point.

## Update

**A cloned copy keeps itself current.** At the start of every task it runs this first:

```sh
node "<skill directory>/scripts/update.mjs" --quiet
```

It checks upstream for a new version and fast-forwards if there is one. The test is **whether this copy has local work**: uncommitted changes, unpushed commits, or not being on a branch all mean it leaves the copy alone. So it never overwrites your edits, and it never merges upstream into a contributor's branch. It checks at most once every 24 hours, and separate copies on the same machine check separately.

To look at the state yourself (reports only, changes nothing):

```sh
node "<skill directory>/scripts/update.mjs" --check
```

**A zip install does not update itself** — download the new version from [Releases](https://github.com/FiretrUCK666/project-forge/releases) and overwrite.

**Is upgrading safe**: `SKILL.md`, `references/`, `templates/`, and `scripts/` are plain text plus zero-dependency scripts — nothing to recompile or migrate. If you modified it as described in [CONTRIBUTING.md](https://github.com/FiretrUCK666/project-forge/blob/main/CONTRIBUTING.md), the update script sees the local changes and skips, so it will not fight your work.

## Usage

Just describe your need in natural language. Trigger phrases include:

- Version control: `set up version control`, `set up git`, `push to a repo`, `create a repo`, `push to GitHub`
- Docs: `write AGENTS.md`, `write README`, `set up LICENSE`, `write contributing guide`
- Release: `publish to npm`, `release`, `set up CI`
- General: `initialize a project`, `start a project`, `new project setup`, `standardize the project`, `normalize the project`, `tidy up the project`, `get the project sorted`

For example:

```
Help me normalize this project
Set up version control and docs for <project directory>
Should this project be published to npm
```

It never starts by writing. The first step is always a survey, then it tells you: what state this project is in, what it is going to do, and **why it skips the rest**.

## What it will not do

- It does not create the project itself: no stack selection, no project skeleton (source, entry files, framework configs) — that is scaffolding's job; this skill governs, and governing runs after the skeleton exists;
- It does not touch your code logic — only version control, remotes, docs, and releases;
- It does not pick a license for you — only criteria and options;
- It never makes a repository public on its own (private by default; public needs your explicit nod);
- No force pushes, no rewriting pushed history, no deleting released versions;
- No deployment or server configuration.

## What is inside

### In the package

This is what you get from a clone, or from the zip on the Releases page:

| Path | Contents |
| --- | --- |
| `SKILL.md` | Entry: hard invariants, capability matrix, execution flow, hard gates |
| `references/survey.md` | Survey protocol: what to read, what each field means, how facts translate into actions |
| `references/version-control.md` | Version control end to end: artifact criteria, ignore rules, identity, commit discipline, rollback tiers, secret gate |
| `references/remote-github.md` | Remote repos: channel discovery, creation, push, metadata, version nodes and release notes, collaboration templates, CI |
| `references/docs-set.md` | Doc set: who reads each doc, responsibilities, writing and sync discipline |
| `references/publish.md` | Release overview: whether to release, where, version semantics, when to bump |
| `references/publish-npm.md` | npm chapter: basics, how to pick up each existing state, scope and common misunderstandings |
| `references/publish-python.md` | Python chapter: the three metadata tables, build and dry run, test index, trusted publishing, versions and fixes |
| `references/publish-go.md` | Go chapter: tag shape, no-upload model, indexing confirmation, retraction, private modules |
| `references/publish-rust.md` | Rust chapter: manifest fields, publish scope, dry run, authentication, fixes |
| `references/plugin-project.md` | Plugin projects: shared traits, decision protocol, what to do without a dedicated chapter and growth rules |
| `references/skill-project.md` | Capability-directory projects: the host loads instructions rather than code, so none of the six questions shares an answer with plugin projects; includes the host-chapter index |
| `references/plugins/` | Per-ecosystem plugin chapters (one file each) |
| `templates/` | Doc skeletons ready to start from, plus standard texts of short licenses |
| `scripts/update.mjs` | Keep this copy current (see Update) |
| `scripts/survey.mjs` | Read-only survey, outputs structured facts |
| `scripts/compose-agents.mjs` | Generate, refresh, or upgrade `AGENTS.md`: fill from project facts, keep/drop conditional sections by facts, report sections still needing a human |
| `scripts/review.mjs` | P4/P5 delivery gate: no missing items, open questions resolved via flags before done |
| `scripts/release-notes.mjs` | Write release notes from a UTF-8 file (non-ASCII never goes through the shell, read back and compare) |
| `scripts/draft-release-notes.mjs` | Draft release notes from the commit log (the platform's generator only produces an English template) |
| `scripts/check-badges.mjs` | Check whether README badges actually render (GitHub badges on private repos do not) |
| `scripts/sync-toc.mjs` | Keep a Markdown TOC in sync with headings (generated from headings, GitHub anchor algorithm) |
| `README.md`, `README.en.md` | This document, in two languages; the Chinese one is authoritative |
| `LICENSE` | Full license text |
| `assets/readme/` | The two images above, as plain SVG you can edit |

### Only in the repo

These **do not ship in the zip**: they serve this repository itself, and whoever gets the package neither needs them nor should be distracted by them. If you want to change this skill, start at [CONTRIBUTING.md](https://github.com/FiretrUCK666/project-forge/blob/main/CONTRIBUTING.md).

| Path | Contents |
| --- | --- |
| `AGENTS.md` | This repo's own contract: mechanisms, invariants, build and verification, hard rules |
| `CONTRIBUTING.md` | The flow for outside contributors: how to ask, how to propose a change, pre-commit gates |
| `.github/` | CI and collaboration templates (workflows, issue and pull request templates) |
| `scripts/dev/preflight.mjs` | Structural self-check when maintaining this skill: reference integrity, kernel consistency, hard rules, package boundary |
| `scripts/dev/selftest.mjs` | Behavioral self-test when maintaining this skill: build fixtures, run for real, assert each decision |

## Scripts

All scripts use only the runtime's built-in modules — **zero dependencies**, cross-platform.

```sh
# Keep this copy current (--check reports only, changes nothing)
node <skill directory>/scripts/update.mjs --quiet

# Survey a project (read-only, writes nothing)
node <skill directory>/scripts/survey.mjs <project directory> --markdown

# Generate, refresh, or upgrade a project's AGENTS.md
node <skill directory>/scripts/compose-agents.mjs <project directory>
node <skill directory>/scripts/compose-agents.mjs <project directory> --check     # verify only; exit 1 on mismatch
node <skill directory>/scripts/compose-agents.mjs <project directory> --status    # inspect only, write nothing
node <skill directory>/scripts/compose-agents.mjs <project directory> --upgrade   # upgrade a hand-written file to the standard structure

# Self-check this skill itself (only when changing it; these two exist in the repo only, not in the zip)
node <skill directory>/scripts/dev/preflight.mjs
node <skill directory>/scripts/dev/selftest.mjs
```

`<skill directory>` is where this skill lives, `<project directory>` is the project you want to work on — usually not the same directory. All paths are passed explicitly, so the working directory does not matter.

`survey.mjs` only answers "what did it read", not "what should be done" — the criteria live in `references/`.
That split is deliberate: facts do not vary by project type, criteria do.

## Design principles

A few principles run through the whole skill, and they are also the bar for "should this practice be added":

**Read-only first.** No files are written before the survey finishes. Applying the same steps to every project is guaranteed to do the wrong thing — a release flow for a docs-only directory is busywork, recreating a repo for a project that already has a remote is destruction.

**Give criteria, not checklists.** Checklists rot (files added/renamed, tools renamed); criteria do not. Wherever something can be written as "how to decide", it is not written as "copy this".

**Write intent, not snapshots.** Version numbers, dates, and one-off decisions do not go into docs — they start rotting the day they are written.
Wherever a value is needed, write "where to read it from".

**Different readers, different writing.** Docs for AI (`AGENTS.md`) carry mechanisms and criteria, and tell it where to read concrete values; docs for humans (`README`, `CONTRIBUTING`) carry concrete copy-pasteable commands.
The same thing is supposed to look different in the two kinds of docs.

**Idempotent, never overwrite.** Every step gives the same result when repeated; existing files are read first and merged, and conflicting content is reported and left alone, never silently picked.

## Requirements

### Runtime

**Node.js 16 or later.** That is the only requirement — all scripts use only Node built-in modules (`node:fs`,
`node:path`, `node:url`, `node:os`, `node:child_process`, `node:crypto`), with **no third-party dependencies**,
nothing to install first. Among the scripts that go online, the ones that fetch pages or call APIs need Node 18's global `fetch`
and fail loudly there instead of silently; the self-update check goes through `git`, so this does not apply to it.

The floor comes from language features used in the scripts: ESM `node:`-prefixed imports, `String.prototype.replaceAll`,
`fs.rmSync`. The most demanding of the three is `replaceAll` (introduced in Node 15); 16 is picked because it is the first LTS covering all of them.

**Versions actually verified**: Node 22 (CI, runs on every push) and Node 24 (dev machine).
16 through 21 are an inferred working range from features, **not tested version by version**; if you hit a problem on those versions,
please file an issue.

### git (optional but strongly recommended)

The scripts do not depend on git: surveying works as usual (it honestly reports "git unavailable"), and doc-related features are unaffected.
**Self-test groups that need git are skipped automatically with an explanation**, never reported as failures.

What needs git is: setting up and maintaining version control, remote repos, push and release, and **self-updating** (a copy with no version history cannot check for a new version on its own). Without git those cannot be done — the survey tells you so explicitly instead of pretending success.

### Network

Surveying and doc generation are fully offline. Only remote repos (create, push, metadata), release steps, and the self-update check need the network.

## How this repo itself is set up

This skill is its own first user: its version control, docs, and CI are set up to its own standard.
In other words, if what this skill teaches were wrong, its own repo would break first. For how it is actually set up, see
[AGENTS.md](https://github.com/FiretrUCK666/project-forge/blob/main/AGENTS.md) — that is this repository's own project contract, and it records the mechanisms and the rules.

This English version is a translation of `README.md` (which stays authoritative); when they disagree, the Chinese one wins, and the other should be synced.

## Troubleshooting

File issues in [Issues](https://github.com/FiretrUCK666/project-forge/issues). To make them actionable, attach:

- Your OS and Node version;
- The full command you ran;
- The complete error text (the original, not a paraphrase);
- If it is about a specific project, that project's stack and rough layout.

## Contributing

See [CONTRIBUTING.md](https://github.com/FiretrUCK666/project-forge/blob/main/CONTRIBUTING.md).

## License

[MIT](LICENSE)
