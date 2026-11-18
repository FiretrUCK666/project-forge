#!/bin/sh
# project-forge: githooks-pre-push
# Cross-host Git pre-push guard: blocks direct push to the default branch,
# allows branch deletions (all-zero local_sha) and PF_ALLOW_DIRECT_PUSH=1.

set -eu

case "${PF_ALLOW_DIRECT_PUSH:-}" in
  1|true|yes)
    exit 0
    ;;
esac

remote_name="${1:-origin}"

resolve_default_branch() {
  if [ -n "${PF_DEFAULT_BRANCH:-}" ]; then
    printf '%s\n' "$PF_DEFAULT_BRANCH"
    return 0
  fi

  sym=$(git symbolic-ref -q "refs/remotes/${remote_name}/HEAD" 2>/dev/null || true)
  if [ -n "$sym" ]; then
    prefix="refs/remotes/${remote_name}/"
    case "$sym" in
      "${prefix}"*)
        printf '%s\n' "${sym#"$prefix"}"
        return 0
        ;;
    esac
  fi

  local_cfg=$(git config --local --get init.defaultBranch 2>/dev/null || true)
  if [ -n "$local_cfg" ]; then
    printf '%s\n' "$local_cfg"
    return 0
  fi

  if git show-ref --verify --quiet refs/heads/main 2>/dev/null; then
    printf 'main\n'
    return 0
  fi
  if git show-ref --verify --quiet refs/heads/master 2>/dev/null; then
    printf 'master\n'
    return 0
  fi

  cfg=$(git config --get init.defaultBranch 2>/dev/null || true)
  if [ -n "$cfg" ]; then
    printf '%s\n' "$cfg"
    return 0
  fi
  printf 'main\n'
}

default_branch=$(resolve_default_branch)
blocked_ref="refs/heads/${default_branch}"
zero_sha40="0000000000000000000000000000000000000000"
zero_sha64="0000000000000000000000000000000000000000000000000000000000000000"

while IFS=' ' read -r local_ref local_sha remote_ref remote_sha || [ -n "${local_ref:-}" ]; do
  [ -z "${local_ref:-}" ] && continue

  case "${local_sha:-}" in
    "$zero_sha40"|"$zero_sha64")
      continue
      ;;
  esac
  if [ "$local_ref" = "(delete)" ]; then
    continue
  fi

  if [ "${remote_ref:-}" = "$blocked_ref" ]; then
    printf '错误：禁止直接推送到默认分支 %s（%s）。\n' "$default_branch" "$blocked_ref" >&2
    printf '[NEXT STEP] 请先切入独立任务分支/工作树，完成后发起评审合并：\n' >&2
    printf '  1. node .agents/skills/dev-flow/scripts/flow.mjs start --task <任务ID> --case <2|3|4>\n' >&2
    printf '  2. 完成验证后提交评审/合并：node .agents/skills/dev-flow/scripts/flow.mjs submit --task <任务ID>\n' >&2
    printf '  （仅紧急情况或人工确认直推时，可临时设置 PF_ALLOW_DIRECT_PUSH=1 后重试）\n' >&2
    exit 1
  fi
done

exit 0
