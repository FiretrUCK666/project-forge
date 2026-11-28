/**
 * markdown.mjs —— Markdown 结构判据薄重导出层（单一真相源位于 `kit/skills/lib/markdown-scan.mjs`）。
 *
 * 保持 `scripts/` 既有导入路径与导出符号 100% 兼容，消除与 `kit/` 的重复实现。
 */

export {
  extractHeadlessSummary,
  fencedSpans,
  findFrontmatterEndLine,
  indexMarkdownSections,
  markerPositions,
  scanLines,
  splitSections,
} from '../../kit/skills/lib/markdown-scan.mjs'
