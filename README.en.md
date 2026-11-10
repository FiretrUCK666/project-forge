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
- [Usage](#usage)
- [Why it stays quiet](#why-it-stays-quiet)
- [What it will not do](#what-it-will-not-do)
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
| **S3 Land** | Repo → remote → docs → automation. Read existing files first, fill only what is missing |
| **S4 Verify and hand off** | Run the project's own gates plus the delivery check, report, ask about cleanup |

It governs; it does not generate the project. It will not pick your stack or write your source.

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
- Pick a license for you, or invent an identity
- **Remove anything it left behind without your explicit confirmation**

## What is inside

```text
SKILL.md            Entry point: which document to read when
references/         Eight sets of criteria, read the one this step needs
templates/          Skeletons that land in the project: contract, docs, licenses, pipelines
scripts/            Survey, generate, check, hand off, sync table of contents
```

`scripts/dev/` serves this repository's own self-check only and never ships in the user package.

## License

[MIT](LICENSE)
