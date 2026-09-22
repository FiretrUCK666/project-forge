# project-forge

[中文](README.md) | English

[![stars](https://img.shields.io/github/stars/FiretrUCK666/project-forge)](https://github.com/FiretrUCK666/project-forge)
[![license](https://img.shields.io/github/license/FiretrUCK666/project-forge)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A516-339933)](README.en.md#requirements)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](README.en.md#requirements)

Forge any project directory into a well-formed project: version control, remote repository, documentation set, and release channel, all in one pass.

Give it a directory. It first surveys read-only to see what the project currently is, then decides on its own what to do and what to skip. It assumes no stack — Node, Python, Rust, Go, Java, docs-only directories, plugin projects, and skill projects are all judged from surveyed facts.

## Contents

<!-- toc:start -->

- [What problem it solves](#what-problem-it-solves)
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

## Install

This is a skill in the generic `SKILL.md` format: one entry file plus `references/`, `templates/`, and `scripts/` alongside it. The frontmatter uses only the two fields every host understands, `name` and `description`, and the scripts are pure Node with no host API calls.

Drop the whole directory into **your host's user-level skill root**:

- **You already have other skills** → put it where they live. That is the most reliable signal; no path to memorize.
- **You have none** → check that host's docs for the location.

```sh
git clone https://github.com/FiretrUCK666/project-forge.git "<your skill root>/project-forge"
```

Keep the directory name `project-forge` — it must match the frontmatter `name`. **Mind the case**: on case-sensitive systems a different case is a different directory.

No registration or restart is needed: hosts discover by directory, and `SKILL.md` is the entry point.

## Update

This skill is distributed by cloning, **not through any package manager**, so updating is pulling the latest code:

```sh
cd <your skill directory>/project-forge
git pull
```

**How to know a new version exists**: see the [Releases](https://github.com/FiretrUCK666/project-forge/releases).
Day-to-day changes are only committed and pushed; tags are cut at release milestones (on an explicit release request), with notes generated automatically. The commit history has more detail, but that is for maintainers.

**Is upgrading safe**: `SKILL.md`, `references/`, `templates/`, and `scripts/` are plain text plus zero-dependency scripts — nothing to recompile or migrate, just `git pull`. If you modified it as described under "Development" below, commit your changes before pulling to avoid conflicts.

## Usage

Just describe your need in natural language. Trigger phrases include:

- Version control: set up version control, set up git, push to a repo, create a repo, push to GitHub, start a project
- Docs: write AGENTS.md, write README, set up LICENSE, write contributing guide
- Release: publish to npm, release, set up CI
- General: standardize the project, normalize the project, tidy up the project

For example:

```
Help me normalize this project
Set up version control and docs for <project directory>
Should this project be published to npm
```

It never starts by writing. The first step is always a survey, then it tells you: what state this project is in, what it is going to do, and **why it skips the rest**.

## What it will not do

- It does not touch your code logic — only version control, remotes, docs, and releases;
- It does not pick a license for you — only criteria and options;
- It never makes a repository public on its own (private by default; public needs your explicit nod);
- No force pushes, no rewriting pushed history, no deleting released versions;
- No deployment or server configuration.

## What is inside

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
| `references/plugins/` | Per-ecosystem plugin chapters (one file each) |
| `templates/` | Doc skeletons ready to start from, plus standard texts of short licenses |
| `scripts/survey.mjs` | Read-only survey, outputs structured facts |
| `scripts/compose-agents.mjs` | Generate, refresh, or upgrade `AGENTS.md`: fill from project facts, keep/drop conditional sections by facts, report sections still needing a human |
| `scripts/preflight.mjs` | Self-check: reference integrity, kernel consistency, hard rules, scripts actually run |
| `scripts/selftest.mjs` | Behavioral self-test: build fixtures, run for real, assert each decision |
| `scripts/release-notes.mjs` | Write release notes from a UTF-8 file (non-ASCII never goes through the shell, read back and compare) |
| `scripts/draft-release-notes.mjs` | Draft release notes from the commit log (the platform's generator only produces an English template) |
| `scripts/check-badges.mjs` | Check whether README badges actually render (GitHub badges on private repos do not) |
| `scripts/sync-toc.mjs` | Keep a Markdown TOC in sync with headings (generated from headings, GitHub anchor algorithm) |
| `scripts/review.mjs` | P4/P5 delivery gate: no missing items, open questions resolved via flags before done |

## Scripts

All scripts use only the runtime's built-in modules — **zero dependencies**, cross-platform.

```sh
# Survey a project (read-only, writes nothing)
node <skill directory>/scripts/survey.mjs <project directory> --markdown

# Generate, refresh, or upgrade a project's AGENTS.md
node <skill directory>/scripts/compose-agents.mjs <project directory>
node <skill directory>/scripts/compose-agents.mjs <project directory> --check     # verify only; exit 1 on mismatch
node <skill directory>/scripts/compose-agents.mjs <project directory> --status    # inspect only, write nothing
node <skill directory>/scripts/compose-agents.mjs <project directory> --upgrade   # upgrade a hand-written file to the standard structure

# Self-check this skill itself
node <skill directory>/scripts/preflight.mjs
node <skill directory>/scripts/selftest.mjs
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
`node:path`, `node:url`, `node:os`, `node:child_process`), with **no third-party dependencies**,
nothing to install first. Scripts that fetch over the network or call APIs need Node 18's global `fetch`
and fail loudly there instead of silently.

The floor comes from language features used in the scripts: ESM `node:`-prefixed imports, `String.prototype.replaceAll`,
`fs.rmSync`. The most demanding of the three is `replaceAll` (introduced in Node 15); 16 is picked because it is the first LTS covering all of them.

**Versions actually verified**: Node 22 (CI, runs on every push) and Node 24 (dev machine).
16 through 21 are an inferred working range from features, **not tested version by version**; if you hit a problem on those versions,
please file an issue.

### git (optional but strongly recommended)

The scripts do not depend on git: surveying works as usual (it honestly reports "git unavailable"), and doc-related features are unaffected.
**Self-test groups that need git are skipped automatically with an explanation**, never reported as failures.

What needs git is: setting up and maintaining version control, remote repos, push and release. Without git those cannot be done — the survey tells you so explicitly instead of pretending success.

### Network

Surveying and doc generation are fully offline. Only remote repos (create, push, metadata) and release steps need the corresponding hosting platform.

## How this repo itself is set up

This skill is its own first user: its version control, docs, and CI are set up to its own standard.
The generic kernel in `AGENTS.md` comes from `templates/agents-kernel.md`, injected by script rather than hand-copied —
`scripts/preflight.mjs` checks they are byte-identical, and CI runs that check too.

In other words, if what this skill teaches were wrong, its own repo would break first.

This English version is a translation of `README.md` (which stays authoritative); when they disagree, the Chinese one wins, and the other should be synced.

## Troubleshooting

File issues in [Issues](https://github.com/FiretrUCK666/project-forge/issues). To make them actionable, attach:

- Your OS and Node version;
- The full command you ran;
- The complete error text (the original, not a paraphrase);
- If it is about a specific project, that project's stack and rough layout.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
