# project-forge

[中文](README.md) | English

[![stars](https://img.shields.io/github/stars/FiretrUCK666/project-forge)](https://github.com/FiretrUCK666/project-forge)
[![license](https://img.shields.io/github/license/FiretrUCK666/project-forge)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A516-339933)](README.en.md#before-you-start)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](README.en.md#before-you-start)

<p align="center">
  <img src="assets/readme/hero.en.svg" width="100%" alt="project-forge: point it at a project directory, it surveys read-only first, then decides from facts what to do. On the right is an excerpt of the survey result">
</p>

Turn any project directory into a well-formed project. Give it a directory and it surveys
read-only first, sees what the project actually is, then decides what to do this time and what
to leave alone.

It assumes no stack. Node, Python, Rust, Go, Java, a docs-only directory, a plugin project, or a
skill project: the decision always comes from the facts it surveyed.

## Contents

<!-- toc:start -->

- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Before you start](#before-you-start)
- [Install](#install)
- [Update](#update)
- [Usage](#usage)
- [What it will not do](#what-it-will-not-do)
- [What is inside](#what-is-inside)
- [Scripts](#scripts)
- [How this repository is set up](#how-this-repository-is-set-up)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

<!-- toc:end -->

## What it does

Between "it runs" and "it looks like a real project" sits a pile of small, error-prone chores:
whether the ignore rules are right, whether build output belongs in the repo, whether commit
identity is set, whether the README promises things that hold, whether the release flow could
leak a secret. None of them is hard. Together they are many, and mistakes surface long after
they are made.

project-forge brings them into one flow:

- **Version control**: ignore rules, text attributes, commit identity, commit discipline, secret scan;
- **Documentation set**: `AGENTS.md`, `README`, `CONTRIBUTING`, `LICENSE` — each with its own reader, none repeating another;
- **Remote repository**: create (private by default), push, metadata, collaboration templates, CI;
- **Release channel**: whether it can ship, where to, how versions are numbered, how to ship safely;
- **Release spec**: for projects that ship, a `RELEASING.md` saying where the notes live, which sections they use, and in what order to publish (the notes are a file in the repo, written before the tag; automation posts it to the release page and fails loudly when the file is missing);
- **Collaboration protocol**: how work actually lands once the setup is done — where changes come from (outside reports, outside pull requests, your own daily edits), where work items live, how review runs, who may merge (irreversible territory always needs a human), and how to clean up after a merge;
- **Hand-off**: once the project is in shape, it asks whether you want its traces cleaned up.

It only governs. It does not create the project itself: it picks no stack and writes no source or
framework config. Governance runs after the skeleton exists.

### Hand-off: done with it, want the traces gone

Once a project has been put in shape, it still carries what this skill left behind — identifiers,
unfilled template placeholders, residue from an interrupted injection. **It always asks at the end
whether you want those cleared**, and it does not finish without asking.

When it asks, it scans the project first and tells you which parts are traces, which belong to the
project, and what to delete or keep for each — then waits for your go-ahead. **It never deletes on
its own**, and irreversible moves such as removing a remote or rewriting history need a separate,
explicit confirmation.

To see the scan yourself:

```sh
node "<skill directory>/scripts/handoff.mjs" "<project directory>" --scan
```

## How it works

<p align="center">
  <img src="assets/readme/pipeline.en.svg" width="100%" alt="project-forge's chain: survey read-only, decide from facts, pass the hard gates, then write, push and release, and ask at the end whether to clear the traces">
</p>

Four steps, and the order matters: survey read-only, decide from facts, pass the hard gates, then
write, push and release. When it is done it also asks whether you want the traces it left cleaned
up — that is the closing move, not a fifth step. The input is surveyed facts, not a preset
checklist, so it will not bolt a release flow onto a docs-only directory and will not recreate a
repo that already has a remote. "Not releasing" and "skipping something" are normal outcomes, not
failures.

**Those four steps set the project up. What follows is a second track: how you use it day to day.**
A change has to be routed — where it came from (an outside report, an outside pull request, your own
daily edit), whether it needs a work item, **which changes must be sent for an independent review first**, who may merge, and how to clean up
afterwards. That track has no stage numbers; read it when you need it, in
`references/collaboration.md`.

## Before you start

**Node.js 16 or newer**, and nothing to install first. Everything you use day to day runs at that
floor (CI runs Node 22, the development machine runs Node 24; 16 through 21 has not been tested
release by release, and reports of trouble there are welcome).

The one exception is the **two scripts that use the network** (`release-notes.mjs` and
`check-badges.mjs`): they use the global `fetch`, which arrived in Node 18, so running them needs
Node 18 or newer. They are only used when maintaining this skill itself.

`git` is optional. Without it the survey and everything about documentation still work, and it
reports "git unavailable" plainly. What needs git is setting up and maintaining version control,
remote repositories, pushing and releasing.

## Install

**Download the package.** No git needed:

<p align="center">
  <a href="https://github.com/FiretrUCK666/project-forge/releases/latest/download/project-forge.zip">
    <b>Download the latest version</b>
  </a>
</p>

Unzip it into your skill directory, then **rename** the `project-forge-<version>/` folder inside it
to `project-forge` — the folder name has to match the `name` field in the `SKILL.md` frontmatter,
and on case-sensitive systems a different case is a different directory.

<p align="center">
  <img src="assets/readme/install.en.svg" width="100%" alt="Two ways to install: the downloaded package keeps itself current; a clone does not update itself">
</p>

**To change it, or to follow every commit**, clone instead:

```sh
git clone https://github.com/FiretrUCK666/project-forge.git "<your skill directory>/project-forge"
```

The two differ in exactly one way: **a clone does not update itself**. A `.git` folder means that
copy is meant for editing, and the tool leaves it alone. How to work on it is in
[CONTRIBUTING.md](https://github.com/FiretrUCK666/project-forge/blob/main/CONTRIBUTING.md).

> **The `Source code` download works too.** That is GitHub's automatic source archive, which extracts
> to a `project-forge-<version>/` directory just like the install package. The only difference is the
> file contents: the install package excludes development-only files (`.github/`, `AGENTS.md`, `scripts/dev/`)
> via `.gitattributes`, whereas the source archive contains the full repository. Rename the extracted
> folder to `project-forge`. Both install, and both keep themselves current. The package is tailored for
> installation, so prefer it.

### Where it goes

Put it in **your host's user-level skill directory**. If you already have other skills, put it
where they live; if you have none, check that host's documentation. Keep the folder named
`project-forge` — it has to match the `name` field in the `SKILL.md` frontmatter. On
case-sensitive systems, a different case is a different directory.

Nothing to register and no restart: hosts discover skills by directory, and `SKILL.md` is the entry.

## Update

<p align="center">
  <img src="assets/readme/update.en.svg" width="100%" alt="How the downloaded copy stays current: at most one version check per hour, a full replacement when there is a newer version, and at most one file replacement per copy every 24 hours">
</p>

The downloaded copy keeps itself current. You do nothing. It quietly asks which version is
latest: same version and it stops there changing nothing, newer version and it swaps in the whole
copy, telling you which version it moved from and to. **It asks at most once an hour** — there is
no point re-fetching an answer that has not changed, so it does not go online on every use.

A copy replaces its files at most once every 24 hours, so it cannot flip several times a day. To
look at the state yourself (report only, no update):

```sh
node "<skill directory>/scripts/update.mjs" --check
```

Where it asks depends on the address that copy records for itself — it ships in the package, in the
`SKILL.md` `metadata.source` field. It recognises the hosting platform's address pattern, so it
**prefers the platform's API**: one request returns both the version and the download address,
without touching the web host. The web address is the fallback.

**When it cannot connect**: that run is skipped (it will not damage your copy or hold up the task),
and the next use retries. But if it has been more than a day without reaching the platform, it says
one line telling you which version this copy is stuck on — that is a warning that you are behind,
not an error.

To make it ask somewhere else (a self-hosted mirror, an internal release), edit `metadata.source` in
that copy's `SKILL.md`; the `PF_UPDATE_SOURCE` environment variable only stands in when the copy
records no address. To turn the automatic check off entirely (read-only sandboxes, offline
machines, audit requirements), set `PF_NO_UPDATE` to any non-empty value: it will not go online,
it will stay silent, and `--check` still answers as usual.

## Usage

Just describe what you want, in plain language:

- Version control: `set up version control`, `configure git`, `push to GitHub`
- Documentation: `write AGENTS.md`, `write a README`, `add a LICENSE`, `write a contributing guide`
- Release: `publish to npm`, `release it`, `add CI`
- General: `initialize this project`, `set this project up`, `standardize this repo`

```
clean up this project
set up version control and docs for D:\work\my-tool
should this project be published to npm?
```

It never starts by writing. The first step is always the survey, and then it tells you what state
the project is in, what it plans to do, and why it is skipping the rest.

### When you say nothing, the default is the whole project

Scope has exactly two forms. You name one concrete thing and it does only that. You say nothing
(just hand it a directory, or say "tidy this up" / "finish everything") and it configures
**everything that project needs**.

"Everything" is not "run every item on a list": what to do is still decided by the facts the
survey found — a docs-only directory gets no release pipeline, an existing remote is never
recreated. It means **nothing that should be done gets skipped**.

**An existing project is the normal case, not the special case.** Most projects already have
git, a remote, a README. The approach is read first, judge second, fill only the gaps — existing
files are read and merged, **never overwritten**, and the existing structure is authoritative.
Only an explicit "rewrite it" replaces a file wholesale.

### When you only want one thing

On an existing project you often just want to add one piece — a CI workflow, a LICENSE. The full
pipeline would stop you for lacking an AGENTS.md, which is not what you asked for.

It tracks scope from the start and only does those few things. The delivery check can be narrowed: 
`node scripts/review.mjs <project directory> --scope=ci`
checks the CI facet only and says nothing about the rest. The available facets and exact usage
are whatever 
`node scripts/review.mjs --help` prints — this file does not copy them, because a
copy drifts.

Without `--scope` the check is still the full one, for the "deliver the whole thing" case.

## What it will not do

- Create the project itself: it picks no stack and writes no skeleton — that is a scaffolder's job;
- Touch your code logic; it handles version control, remotes, docs and releases only;
- Choose a license for you — it gives criteria and options;
- Make a repository public on its own (private by default);
- Force-push, rewrite pushed history, or delete a published release;
- Delete what it left behind without your confirmation;
- Deploy or configure servers.

## What is inside

### What is inside

**No per-file list here**: it would become a checklist somebody has to remember to update,
and a missed line shows up as "a file is in the package but nobody knows". The authority is
the real `git archive` export; `.gitattributes` decides which directories stay out.

Four kinds of thing:

| Path | What it is for |
| --- | --- |
| `SKILL.md` | Entry point: hard invariants, capability matrix, execution flow, hard gates |
| `references/` | Criteria and method, read in full per situation: survey, version control, remote, docs, release, collaboration, hand-off |
| `templates/` | Drop-in skeletons: project contract, README, contributing guide, release spec, work record, pull request and issue templates, two pipelines, several full license texts |
| `scripts/` | Zero-dependency tools: self-update, survey, inject, delivery gate, hand-off, release-note sender, badge check, TOC sync, unzip, plus the shared `lib/` |
| `README.md`, `README.en.md`, `LICENSE`, `assets/readme/` | This documentation (paired, Chinese is authoritative), the license text, and the README cards |

**What this repository keeps for itself** (never in the package) is written in
[`AGENTS.md`](https://github.com/FiretrUCK666/project-forge/blob/main/AGENTS.md) — it is for
people maintaining this skill, not for people using it.


## Scripts

Every script uses only built-in modules: no dependencies, cross-platform.

```sh
# Keep this copy current (--check reports without updating)
node "<skill directory>/scripts/update.mjs" --quiet

# Survey a project (read-only, writes nothing)
node "<skill directory>/scripts/survey.mjs" "<project directory>" --markdown

# Generate, refresh or upgrade a project's AGENTS.md
node "<skill directory>/scripts/compose-agents.mjs" "<project directory>"
node "<skill directory>/scripts/compose-agents.mjs" "<project directory>" --status    # look, do not write
node "<skill directory>/scripts/compose-agents.mjs" "<project directory>" --upgrade   # upgrade a hand-written one

# Survey the traces this skill left in a project (read-only)
node "<skill directory>/scripts/handoff.mjs" "<project directory>" --scan     # list traces and what to do with each
node "<skill directory>/scripts/handoff.mjs" "<project directory>" --verify   # judge whether it is already clean

# Self-checks for this skill (run only when changing it)
node "<skill directory>/scripts/dev/preflight.mjs"
node "<skill directory>/scripts/dev/selftest.mjs"
```

`<skill directory>` is where this skill lives and `<project directory>` is the project you want it
to work on. They are usually not the same directory. Keep the quotes when a path contains spaces
or non-ASCII characters — that is not styling, it is whether the command runs at all.

## How this repository is set up

This skill is its own first user: its version control, documentation and CI all follow its own
standard. If what it teaches were wrong, its own repository would break first. Details are in
[AGENTS.md](https://github.com/FiretrUCK666/project-forge/blob/main/AGENTS.md).

This file is the English translation; `README.md` is authoritative. When the two disagree, the
Chinese one wins and this one gets updated.

## Troubleshooting

Open an [issue](https://github.com/FiretrUCK666/project-forge/issues). To make it findable, include:

- your OS and Node version;
- the exact command you ran;
- the full error text (the original, not a description of it);
- if it concerns a specific project, that project's stack and rough directory layout.

## Contributing

See [CONTRIBUTING.md](https://github.com/FiretrUCK666/project-forge/blob/main/CONTRIBUTING.md).

## License

[MIT](LICENSE)