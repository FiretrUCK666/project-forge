<p align="center">
  <img src="assets/readme/hero-en.svg" alt="project-forge workflow diagram showing a setup branch turning a folder into a documented GitHub repo" width="100%">
</p>

<p align="center">
  <a href="README.md">简体中文</a> | <strong>English</strong>
</p>

<p align="center">
  <a href="RELEASING.md"><img src="https://img.shields.io/badge/version-v5.0.0-4E7496?style=flat-square" alt="Version v5.0.0"></a>
  <a href="#install-and-get-started"><img src="https://img.shields.io/badge/node-%3E%3D18-1F6F5B?style=flat-square" alt="Node.js 18 or newer"></a>
  <a href="SKILL.md"><img src="https://img.shields.io/badge/dependencies-0-1F6F5B?style=flat-square" alt="Zero third-party dependencies"></a>
  <a href="#using-the-5-everyday-skills"><img src="https://img.shields.io/badge/kit-5%20skills-D96B27?style=flat-square" alt="Five bundled local dev skills"></a>
  <a href="#how-it-gets-a-repo-in-shape"><img src="https://img.shields.io/badge/platform-GitHub-172033?style=flat-square" alt="Designed for GitHub workflows"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-526075?style=flat-square" alt="MIT License"></a>
</p>

Starting a fresh directory or stepping into a repository that has grown over months usually stalls on surrounding engineering setup rather than product code: `.gitignore` misses local secrets, design notes drift away from implementation, branches land without real test output, and edits break companion files without warning.

**project-forge** puts that surrounding structure in order in one pass. It surveys your directory read-only first, then fills in missing Git baselines, architecture docs, `AGENTS.md`, GitHub checks, and five everyday development skills without overwriting what you wrote by hand.

## Five Everyday Mistakes It Prevents

- **Existing docs and CI stay untouched**: Handwritten `README.md`, `CONTRIBUTING.md`, workflows, and custom local skills remain intact. Before writing managed files into a non-empty repository, it creates a tar snapshot outside the repo directory so rolling back is trivial.
- **PRDs, specs, and checklists track branch state**: Planning docs in `docs/prd/`, `docs/specs/`, and `docs/todo/` share structured YAML frontmatter and `YYMMDD-issue<N>-<slug>-{prd,spec,todo}.md` naming so documentation moves in step with issues and pull requests.
- **Require real command output instead of guesswork**: Changes cannot merge into the default branch on self-reported code reading alone; they need passing contract checks, real execution suites, and an independent context review.
- **Reminders when coupled files need syncing**: A dependency table inside `AGENTS.md` links templates, libraries, and companion docs so modifying one file surfaces every sibling file that must be checked together.
- **Tiered test checks keep suites fast**: Built-in `dev-govern` separates verification into quick tests, full fixtures, and merge gates while flagging oversized files or slow mock-heavy tests.

## Contents

<!-- toc:start -->

- [Five Everyday Mistakes It Prevents](#five-everyday-mistakes-it-prevents)
- [How It Gets a Repo in Shape](#how-it-gets-a-repo-in-shape)
- [Using the 5 Everyday Skills](#using-the-5-everyday-skills)
- [Install and Get Started](#install-and-get-started)
- [Guardrails](#guardrails)
- [Script Reference](#script-reference)
- [License](#license)

<!-- toc:end -->

## How It Gets a Repo in Shape

<p align="center">
  <img src="assets/readme/workflow-en.svg" alt="Onboarding convergence flow from three repository starting points into four setup steps" width="100%">
</p>

Whether you start from an empty folder, a half-configured side project, or an active team repository, **project-forge** follows the same four-step path and leaves handwritten content intact:

1. **Read-only survey**: Inspects existing files, Git baseline, configured remotes, and account permissions without changing anything. On a blank folder, answering three or four short questions generates the starter baseline.
2. **Plan from observed facts**: Preserves handwritten READMEs, non-standard directories, and existing custom skills, filling only missing items and asking before making choices like license selection.
3. **Snapshot and scaffold in sequence**: Saves an external tar backup of non-empty repositories, then builds strictly in order: **Repo → docs → remote → automation**. After setting up Git and installing the five everyday skills, `dev-explore` inspects real module boundaries to generate a concise `AGENTS.md` (under 30KB) and `docs/TDD.md`, followed by GitHub remotes and checks.
4. **Verify and hand off**: Re-checks consistency and cross-links across generated files, and lists any temporary helper markers for explicit confirmation before cleaning them up.

## Using the 5 Everyday Skills

<p align="center">
  <img src="assets/readme/architecture-en.svg" alt="Five bundled local skills connected to the four merge gate checks" width="100%">
</p>

Once installed under `.agents/skills/`, these five skills work from plain requests—you do not need to memorize script flags. `AGENTS.md` maps natural intent to the matching skill and helper script automatically.

| What you ask in plain words | Skill | What it handles |
| --- | --- | --- |
| "Map the entrypoints and module boundaries first" | `dev-explore` | Read-only scan of codebase structure, boundaries, and check commands without editing files |
| "Draft a spec and task list for this change" | `dev-plan` | Writes and audits `docs/prd/`, `docs/specs/`, and `docs/todo/` with clear scope and risk level |
| "Pick up this issue, work on a branch, and open a PR" | `dev-flow` | Creates an isolated branch or worktree, runs local gates, submits PRs, and updates doc status |
| "Review this PR from an independent angle" | `dev-review` | Spawns an isolated review context to check criteria line by line and test failure cases |
| "Audit stale docs, duplication, or slow tests" | `dev-govern` | Checks contract sync, spots oversized modules or low-value tests, and prepares releases |

A typical day follows four simple prompts:

1. Ask to `"Explore how the config parser routes errors"` so `dev-explore` returns real entrypoints and test commands.
2. Ask to `"Create a spec and checklist for adding validation"` so `dev-plan` prepares frontmatter docs and freezes acceptance criteria.
3. Ask to `"Implement this on a new branch, run local checks, and open a PR"` so `dev-flow` handles isolation, checks, and submission.
4. Ask to `"Run an independent review on the PR, then merge and clean up"` so `dev-review` and `dev-flow` verify, merge, and tidy up the branch.

Evidence always follows a strict hierarchy: **static and contract checks outrank runtime smoke tests, runtime output outranks code reading, and independent review completes before doc archiving**.

## Install and Get Started

- **Runtime**: Node.js 18 or newer (`>= 18`).
- **Zero external dependencies**: Every script uses only Node built-in modules (`node:*`).

Clone or place `project-forge` in your skills folder, open your target project directory, and start with a plain request:

```text
Survey this project directory first,
and list what setup items are missing.
```

Empty folders prompt three or four brief questions about stack and license; existing repositories keep handwritten docs and working workflows untouched.

## Guardrails

To protect published history and prevent skipped checks, actions are separated into routine branch work and human-confirmed operations:

- **Boundaries depend on whether they can be undone**: Routine work covers actions like pushing your own branch and opening or updating a PR because both can be reverted. Merging directly into the default branch outside normal review, tagging a release, publishing artifacts, or changing repository visibility cannot be undone and require explicit confirmation first.
- **Clear separation between routine merges and gate changes**: When an independent review passes with zero open failures, the reviewer merges directly; any change involving **weakening a gate**—removing tests, loosening assertions, skipping checks, or relaxing CI—always requires human confirmation.
- **Never rewrite pushed history, always verify after writes**: Force-pushing and rewriting published commits never run automatically. After pushing branches, opening PRs, or publishing releases, the scripts read back live GitHub state to verify everything landed accurately.

## Script Reference

Normal work routes through `AGENTS.md` automatically. Expand below if you want to invoke individual checks manually or wire them into CI:

<details>
<summary>Inspect underlying CLI scripts</summary>

| Script | Purpose |
| --- | --- |
| `node scripts/survey.mjs <dir>` | Read-only scan of repository layout, docs, remotes, and gaps |
| `node scripts/backup.mjs create <dir>` | Create an external tar snapshot before modifying an existing repo |
| `node scripts/equip.mjs <dir>` | Install and verify the five bundled `.agents/skills/` kits |
| `node scripts/compose-agents.mjs <dir>` | Build or safely refresh a `<= 30KB` `AGENTS.md` contract |
| `node scripts/review.mjs <dir>` | Audit repository readiness against project contracts |
| `node scripts/handoff.mjs <dir>` | List and remove temporary forge markers when stepping back |
| `node scripts/sync-toc.mjs README.md README.en.md` | Keep bilingual README tables of contents synchronized |
| `node scripts/update.mjs` | Check and sync local toolkit updates |

</details>

## License

Released under the [MIT](LICENSE) License. See [CONTRIBUTING.md](CONTRIBUTING.md) and [RELEASING.md](RELEASING.md) for collaboration and release details.
