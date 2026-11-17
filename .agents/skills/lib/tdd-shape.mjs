/**
 * tdd-shape.mjs —— 判出「这个项目该有什么形态的 TDD」。
 *
 * ## 为什么需要它
 *
 * TDD 模板曾经是一张固定的 10 节表：文档信息、术语表、架构全景、核心流程、
 * 不变量、数据模型、接口、部署……对某些项目刚好，对另一些项目全错：
 *
 * - 一个纯 CLI 工具没有数据模型、没有部署拓扑、没有对外 HTTP 接口；
 * - 一个数据管道没有「关键交互」，但必须有「数据契约」与「幂等边界」；
 * - 一个前后端一体的产品需要「技术栈选型」和「接口设计」，模板里连位置都没有；
 * - 一个算法库需要「复杂度与性能基线」，模板里也没有。
 *
 * 于是要么硬填（写一堆「不适用」），要么整节删（删完就没有形状了）。
 *
 * ## 做法
 *
 * 不猜「这个项目是什么类型」，而是**从仓库里读得出的事实判出来**：
 * 有 `pom.xml` 就有后端运行时；有 `Dockerfile` 就有部署拓扑；有 `contracts/openapi.yaml`
 * 就有接口契约；有 `migrations/` 就有数据模型。这些都能从 `survey` 的既有事实里拿到，
 * 不需要新写一套探测。
 *
 * 判出来的是**一组开关**，交给模板渲染器决定保留哪几节。
 *
 * ## 边界
 *
 * 判不出来就**保守全留**——多一节空模板比少一节该有的内容安全：
 * 空的会被人看见并删掉，缺的不会。
 */

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

  for (const id of ['data', 'api', 'deploy', 'frontend', 'security', 'perf']) {
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

/**
 * 把形状开关翻成「模板里该删哪几节」。
 *
 * 只删**模板声明为 optional 且当前没开**的节；主干节永远不在这里出现。
 */
export function tddDropSections(shape) {
  const drop = new Set()
  for (const def of TDD_SHAPES) {
    if (def.always) continue
    if (!shape.enabled.has(def.id)) drop.add(def.id)
  }
  return drop
}
