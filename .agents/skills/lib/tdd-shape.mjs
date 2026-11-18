
/** 一个形状开关的定义：`id` 与模板章节 id 对应，`when` 说明它凭什么被打开。 */
export const TDD_SHAPES = Object.freeze([
  {
    id: 'stack',
    label: '技术栈选型',
    when: '只要是多生态、或声明了运行时下限，就该有一张「哪层用什么」的表',
    always: true,
  },
  {
    id: 'data',
    label: '数据模型与持久化契约',
    when: '有数据库迁移、ORM 配置、schema 文件或持久化目录',
  },
  {
    id: 'api',
    label: '对外接口与交互时序',
    when: '有 OpenAPI/GraphQL/proto 契约、HTTP 路由或 CLI 子命令表',
  },
  {
    id: 'deploy',
    label: '部署与环境差异',
    when: '有 Dockerfile、compose、k8s 清单或部署脚本',
  },
  {
    id: 'integration',
    label: '外部集成与依赖边界',
    when: '有多个生态、或检测到外部服务凭据键、或存在第三方 SDK 依赖',
  },
  {
    id: 'perf',
    label: '性能与容量基线',
    when: '是库/算法包，或代码量足够大（有明确的性能敏感面）',
  },
  {
    id: 'frontend',
    label: '前端与交互层',
    when: '检测到前端框架清单（React/Vue/Svelte 等）',
  },
  {
    id: 'security',
    label: '安全与权限边界',
    when: '检测到鉴权/加密/凭据相关依赖或配置',
  },
  {
    id: 'build',
    label: '构建、测试与发布链路',
    when: '有构建脚本、CI 流水线或发布配置——凡是要「产出一个东西」的项目都算',
    always: true,
  },
  {
    id: 'observability',
    label: '可观测性与运维',
    when: '有长期运行的服务（Dockerfile / k8s / systemd / 守护进程配置）',
  },
  {
    id: 'migration',
    label: '迁移与兼容策略',
    when: '有数据库迁移、版本化 API 或多版本共存痕迹',
  },
  {
    id: 'decisions',
    label: '关键决策记录',
    when: '任何有一定历史的项目都该有——它防止已否掉的方案被重新拿出来讨论',
    always: true,
  },
  {
    id: 'glossary-only',
    label: '已知限制与技术债',
    when: '所有长期维护的项目都该有——不写不会让它消失，只会让接手的人以为是 bug',
    always: true,
  },
])

/** 从文件路径清单里认出某类特征。只看路径，不求内容——路径已经足够可靠。 */
const PATH_PROBES = Object.freeze({
  data: [
    /(?:^|\/)(?:migrations?|migrate)\//i,
    /(?:^|\/)schema\.(?:sql|prisma|graphql)$/i,
    /(?:^|\/)prisma\/schema\.prisma$/i,
    /(?:^|\/)(?:models?|entities)\/.*\.(?:py|ts|js|java|go|rb|php|cs)$/i,
    /(?:^|\/)alembic\.ini$/i,
    /(?:^|\/)flyway|(?:^|\/)liquibase/i,
  ],
  api: [
    /(?:^|\/)openapi\.(?:ya?ml|json)$/i,
    /(?:^|\/)swagger\.(?:ya?ml|json)$/i,
    /(?:^|\/)contracts?\/.*\.(?:ya?ml|json|proto)$/i,
    /\.proto$/i,
    /(?:^|\/)(?:routes?|controllers?|handlers?|endpoints?)\//i,
  ],
  deploy: [
    /(?:^|\/)Dockerfile(?:\..+)?$/i,
    /(?:^|\/)docker-compose\.(?:ya?ml|yml)$/i,
    /(?:^|\/)compose\.(?:ya?ml|yml)$/i,
    /(?:^|\/)k8s\//i,
    /(?:^|\/)helm\//i,
    /(?:^|\/)deploy\//i,
    /(?:^|\/)\.github\/workflows\//i,
  ],
  frontend: [
    /(?:^|\/)(?:vite|next|nuxt|svelte|astro)\.config\./i,
    /(?:^|\/)src\/.*\.(?:tsx|jsx|vue|svelte)$/i,
    /(?:^|\/)index\.html$/i,
  ],
  security: [
    /(?:^|\/)(?:auth|security|acl|permissions?)\//i,
    /(?:^|\/)(?:middleware|guards?)\/.*(?:auth|token|jwt|perm)/i,
    /\.env\.example$/i,
    /(?:^|\/)CODEOWNERS$/i,
  ],
  perf: [
    /(?:^|\/)bench(?:mark)?s?\//i,
    /(?:^|\/)perf\//i,
    /\.bench\./i,
  ],
  observability: [
    /(?:^|\/)Dockerfile(?:\..+)?$/i,
    /(?:^|\/)(?:k8s|helm)\//i,
    /(?:^|\/)(?:systemd|supervisor)\//i,
    /(?:^|\/)(?:logging|telemetry|metrics|tracing|observability)\//i,
    /(?:^|\/)docker-compose\.(?:ya?ml|yml)$/i,
  ],
  migration: [
    /(?:^|\/)(?:migrations?|migrate)\//i,
    /(?:^|\/)alembic\.ini$/i,
    /(?:^|\/)(?:v1|v2)\/.*\.(?:mjs|ts|js|go|py|java)$/i,
    /(?:^|\/)(?:CHANGELOG|MIGRATION)\.md$/i,
  ],
})

function anyMatch(paths, probes) {
  return paths.some((p) => probes.some((re) => re.test(p)))
}

/**
 * 判出该开哪几个形状开关。
 *
 * @param {{paths?: string[], kinds?: string[], runtimeRequirements?: string[], codeFiles?: number}} facts
 * @returns {{enabled: Set<string>, reasons: Record<string,string>}}
 */
export function detectTddShapes(facts = {}) {
  const paths = Array.isArray(facts.paths) ? facts.paths : []
  const kinds = Array.isArray(facts.kinds) ? facts.kinds : []
  const enabled = new Set(['stack'])
  const reasons = { stack: '任何项目都该说清自己用什么技术' }

  const has = (id) => {
    const probes = PATH_PROBES[id]
    if (!probes) return false
    const hit = paths.find((p) => probes.some((re) => re.test(p)))
    if (hit) reasons[id] = `检出 ${hit}`
    return Boolean(hit)
  }

  for (const id of ['data', 'api', 'deploy', 'frontend', 'security', 'perf', 'observability', 'migration']) {
    if (has(id)) enabled.add(id)
  }

  // 多生态 = 有跨服务/跨语言的协作面，才需要「外部集成」这一节
  if (kinds.length > 1) {
    enabled.add('integration')
    reasons.integration = `检出 ${kinds.length} 种生态（${kinds.join('、')}）`
  }

  // 代码量足够大时，性能是可观测的问题而不是空谈
  if ((facts.codeFiles ?? 0) >= 300 && !enabled.has('perf')) {
    const bench = paths.find((p) => /(?:^|\/)(?:test|tests)\//i.test(p) && /\.(?:mjs|js|ts|py|go|rs|java)$/i.test(p))
    if (bench) {
      enabled.add('perf')
      reasons.perf = `代码 ${facts.codeFiles} 个文件，且已有测试目录`
    }
  }

  return { enabled, reasons }
}

import { FORM_INDEPENDENT_CORE } from './doc-requirements.mjs'

/**
 * 把形状开关翻成「模板里该删哪几节」。
 *
 * 只删**模板声明为 optional 且当前没开**的节，或项目声明 `omit_sections` 明确豁免的非核心节；
 * `FORM_INDEPENDENT_CORE.tdd` 三项主干节永远不在这里出现。
 */
export function tddDropSections(shape, { omit = null, required = null } = {}) {
  const core = new Set(FORM_INDEPENDENT_CORE.tdd ?? [])
  const omitSet = omit instanceof Set ? omit : new Set(Array.isArray(omit) ? omit : [])
  const reqSet = required instanceof Set ? required : new Set(Array.isArray(required) ? required : [])
  const drop = new Set()
  for (const def of TDD_SHAPES) {
    if (core.has(def.id)) continue
    if (reqSet.has(def.id)) continue
    if (omitSet.has(def.id)) {
      drop.add(def.id)
      continue
    }
    if (def.always) continue
    if (!shape?.enabled?.has?.(def.id)) drop.add(def.id)
  }
  for (const optId of ['doc-info', 'flow', 'invariants']) {
    if (!core.has(optId) && omitSet.has(optId) && !reqSet.has(optId)) drop.add(optId)
  }
  return drop
}
