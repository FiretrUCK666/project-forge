/**
 * injections-data-studio-ux.mjs —— Milestone B Wave 3 (`studio-ux-lazy-renderer`, C9..C12)
 * 4 条专属故障注入复验数据表（I1021-I1024，不与 Wave 1/2 及既有 I961..I964 重复）。
 */

export const INJECTIONS_STUDIO_UX = [
  {
    id: 'I1021',
    what: 'C9 visual-render-assets: 回流 will-change:transform 到缩放画布容器导致拖拽文字模糊',
    file: 'kit/skills/lib/visual-render-assets.mjs',
    alsoDropIn: ['.agents/skills/lib/visual-render-assets.mjs'],
    from: "'.pf-canvas-stage{flex:1;min-height:0;position:relative;overflow:hidden;cursor:grab;user-select:none;touch-action:none}.pf-canvas-stage.is-grabbing{cursor:grabbing}",
    to: "'.pf-canvas-stage{flex:1;min-height:0;position:relative;overflow:hidden;cursor:grab;user-select:none;touch-action:none}.pf-canvas-stage.is-grabbing{cursor:grabbing;will-change:transform}",
    expect: '[StudioUX-C9]',
  },
  {
    id: 'I1022',
    what: 'C10 visual-render-svg: 关闭非首屏 Tab 客户端懒渲染导致双份预渲与体积膨胀',
    file: 'kit/skills/lib/visual-render-svg.mjs',
    alsoDropIn: ['.agents/skills/lib/visual-render-svg.mjs'],
    from: 'export const LAZY_TAB_RENDER = true',
    to: 'export const LAZY_TAB_RENDER = false',
    expect: '[StudioUX-C10]',
  },
  {
    id: 'I1023',
    what: 'C11 visual-brief: 退化导览目标解析重新全绑 candidateIds[0]',
    file: 'kit/skills/lib/visual-brief.mjs',
    alsoDropIn: ['.agents/skills/lib/visual-brief.mjs'],
    from: 'export function resolveWalkthroughTarget({ text = \'\', stepIdx = 0, candidateIds = [], featureList = [], preferredId = \'\' }) {\n  if (preferredId && featureList.some((f) => f.id === preferredId)) return preferredId',
    to: 'export function resolveWalkthroughTarget({ candidateIds = [] }) {\n  return candidateIds[0] || \'\'\n  if (false) return \'\'',
    expect: '[StudioUX-C11]',
  },
  {
    id: 'I1024',
    what: 'C11 visual-render-client: 放宽 ?from= 父简报参数白名单正则允许 javascript:/../ 注入',
    file: 'kit/skills/lib/visual-render-client.mjs',
    alsoDropIn: ['.agents/skills/lib/visual-render-client.mjs'],
    from: "export const SAFE_FROM_BRIEF_RE_SRC = '^[a-z0-9\\\\u4e00-\\\\u9fa5._-]{1,80}$'",
    to: "export const SAFE_FROM_BRIEF_RE_SRC = '.+'",
    expect: '[StudioUX-C11]',
  },
]
