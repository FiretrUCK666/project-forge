---
name: dev-explore
description: |
  只读探索代码库结构、架构入口、模块依赖、测试分布与近期变更热点。
  触发词：探索代码、梳理架构、这个模块怎么跑的、找入口、代码结构、项目结构、
  先看看代码、哪里定义的、模块边界、read codebase、explore repo、find entrypoints。
  完全只读，不修改任何文件，不创建分支或工作树。
---

# dev-explore：只读架构与源码地图

当用户想理解仓库结构、追踪模块入口、寻找测试文件或查看近期修改热点时使用本技能。

## 硬性纪律

1. **严格只读**：本技能只读取和总结事实，**严禁修改、创建或删除任何文件**。
2. **脚本先行**：动手逐个目录 `ls` 或盲目读文件之前，先运行一次脚本拿到紧凑全景地图。
3. **不越权改动**：探索完若需要改代码或写规划，转交规划或流转技能接手。

## 标准流程

### 第一步：跑只读仓库地图脚本

```sh
node ".agents/skills/dev-explore/scripts/repo-map.mjs" "."
```

若用户点名了某个子目录或模块（如 `src/auth` 或 `packages/core`），加上 `--focus` 下钻：

```sh
node ".agents/skills/dev-explore/scripts/repo-map.mjs" "." --focus "<subdir>"
```

需要结构化消费时追加 `--json`。

### 第二步：按图索骥读权威文档与入口

拿到输出后，按以下优先级读关键文件（不读无关大文件与构建产物目录）：

1. 根目录 `AGENTS.md`（若聚焦了子目录且存在 `<subdir>/AGENTS.md`，一并读取其局部特例）。
2. `docs/TDD.md` 与 `docs/specs/` 中状态为 `approved` 或 `implemented` 的规格文档。
3. 地图标出的入口文件与高改动热点文件，以及对应的测试文件。

### 第三步：输出简洁结论

向用户或上游流程交代清楚：

- 项目形态、生态与入口文件位置
- 核心目录职责与模块边界
- `AGENTS.md` Dev Profile 声明的验证命令与高风险路径
- 近期高频变更热点与相关测试分布
