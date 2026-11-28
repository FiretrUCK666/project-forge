/**
 * static-evidence-erd.mjs —— 多生态 Schema / SQL / ORM 数据实体（ERD）静态证据抽取。
 *
 * 支持 Prisma、SQL DDL、TypeORM、Java/Kotlin JPA `@Entity`、Drizzle、
 * Python SQLAlchemy / Django `models.Model`、Ruby ActiveRecord（`schema.rb`）、Go GORM 与 Rust Diesel。
 */

import { join } from 'node:path'

import { readTextSafe } from './git.mjs'
import { MAX_ANALYZE_FILE_BYTES } from './static-analyzer.mjs'
import { stripCodeCommentsLines } from './static-gates-lexer.mjs'

function stripSqlComments(text) {
  return String(text ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '')
}

function readCleanCode(repoRoot, rel) {
  const txt = readTextSafe(join(repoRoot, rel), MAX_ANALYZE_FILE_BYTES)
  if (!txt) return null
  const ext = rel.includes('.') ? rel.split('.').pop().toLowerCase() : ''
  return { raw: txt, ext, codeLines: stripCodeCommentsLines(txt, ext) }
}

export function extractErdEvidence(repoRoot, repoFiles) {
  const entities = new Map()
  const relations = []
  const seenRel = new Set()
  const addEntity = (name, source, fields = []) => {
    const clean = String(name ?? '').trim().replace(/^["'`]|["'`]$/g, '')
    if (!clean) return null
    if (!entities.has(clean)) entities.set(clean, { name: clean, source, fields: [] })
    const ent = entities.get(clean)
    for (const f of fields) {
      if (f && !ent.fields.includes(f)) ent.fields.push(f)
    }
    return ent
  }
  const addRelation = (from, to, label = 'references') => {
    const f = String(from ?? '').trim().replace(/^["'`]|["'`]$/g, '')
    const t = String(to ?? '').trim().replace(/^["'`]|["'`]$/g, '')
    if (!f || !t || f === t) return
    const key = `${f}->${t}:${label}`
    if (seenRel.has(key)) return
    seenRel.add(key)
    relations.push({ from: f, to: t, label })
  }

  for (const rel of repoFiles) {
    const low = rel.toLowerCase()
    if (low.endsWith('.prisma')) {
      const raw = readTextSafe(join(repoRoot, rel), MAX_ANALYZE_FILE_BYTES)
      if (!raw) continue
      const clean = stripCodeCommentsLines(raw, 'ts').join('\n')
      for (const m of clean.matchAll(/\bmodel\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)\}/g)) {
        const modelName = m[1]
        const fields = []
        for (const rawLine of m[2].split('\n')) {
          const line = rawLine.trim()
          if (!line || line.startsWith('@@')) continue
          const fm = /^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_?[\]]*)/.exec(line)
          if (!fm) continue
          fields.push(`${fm[1]}:${fm[2]}`)
          const targetType = fm[2].replace(/[?[\]]+$/g, '')
          if (/@relation\b/.test(line) && /^[A-Z]/.test(targetType)) {
            addRelation(modelName, targetType, fm[1])
          }
        }
        addEntity(modelName, rel, fields)
      }
      continue
    }

    if (low.endsWith('.sql')) {
      const raw = readTextSafe(join(repoRoot, rel), MAX_ANALYZE_FILE_BYTES)
      if (!raw) continue
      const clean = stripSqlComments(raw)
      for (const m of clean.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[A-Za-z0-9_"`]+\.)?([A-Za-z0-9_"`]+)\s*\(([\s\S]*?)\)\s*;/gi)) {
        const tbl = m[1].replace(/["`]/g, '')
        const body = m[2]
        const fields = []
        for (const seg of body.split(/,\s*\n|,\s*(?=[A-Za-z_"`])/)) {
          const line = seg.trim()
          if (!line) continue
          const fk = /\bFOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+(?:[A-Za-z0-9_"`]+\.)?([A-Za-z0-9_"`]+)/i.exec(line)
          if (fk) { addRelation(tbl, fk[2].replace(/["`]/g, ''), fk[1].trim()); continue }
          if (/^(?:PRIMARY\s+KEY|UNIQUE|CONSTRAINT|CHECK|INDEX|KEY)\b/i.test(line)) {
            const refM = /\bREFERENCES\s+(?:[A-Za-z0-9_"`]+\.)?([A-Za-z0-9_"`]+)/i.exec(line)
            if (refM) addRelation(tbl, refM[1].replace(/["`]/g, ''), 'fk')
            continue
          }
          const col = /^["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?\s+([A-Za-z0-9_()]+)/.exec(line)
          if (col) {
            fields.push(`${col[1]}:${col[2]}`)
            const inlineRef = /\bREFERENCES\s+(?:[A-Za-z0-9_"`]+\.)?([A-Za-z0-9_"`]+)/i.exec(line)
            if (inlineRef) addRelation(tbl, inlineRef[1].replace(/["`]/g, ''), col[1])
          }
        }
        addEntity(tbl, rel, fields)
      }
      for (const am of clean.matchAll(/\bALTER\s+TABLE\s+(?:ONLY\s+)?(?:[A-Za-z0-9_"`]+\.)?([A-Za-z0-9_"`]+)\s+ADD\s+(?:CONSTRAINT\s+[A-Za-z0-9_"`]+\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+(?:[A-Za-z0-9_"`]+\.)?([A-Za-z0-9_"`]+)/gi)) {
        const fromTbl = am[1].replace(/["`]/g, '')
        const fkCol = am[2].replace(/["`\s]/g, '')
        const toTbl = am[3].replace(/["`]/g, '')
        addEntity(fromTbl, rel, fkCol ? [fkCol] : [])
        addEntity(toTbl, rel, [])
        addRelation(fromTbl, toTbl, fkCol || 'fk')
      }
      continue
    }

    if (/\.(?:ts|tsx|js|mjs|py|go|rs|java|kt|kts|rb)$/i.test(low)) {
      const cleaned = readCleanCode(repoRoot, rel)
      if (!cleaned) continue
      const text = cleaned.codeLines.join('\n')
      if (/\.(?:ts|tsx|js|mjs)$/i.test(low) && /@(?:Entity|Table)\b/.test(text)) {
        for (const m of text.matchAll(/@(?:Entity|Table)(?:\s*\([^)]*\))?(?:\s*@[A-Za-z_][A-Za-z0-9_]*(?:\s*\([^)]*\))?)*\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)[^{]*\{([\s\S]*?)\n\}/g)) {
          const cols = [...m[2].matchAll(/@(?:PrimaryGeneratedColumn|PrimaryColumn|Column|ForeignKey|Field|Prop)\s*(?:\([^)]*\))?(?:\s*@[A-Za-z_][A-Za-z0-9_]*(?:\s*\([^)]*\))?)*\s*(?:(?:public|private|protected|readonly|declare)\s+)*([A-Za-z_][A-Za-z0-9_]*)/g)].map((c) => c[1])
          addEntity(m[1], rel, cols)
          for (const rm of m[2].matchAll(/@(?:ManyToOne|OneToMany|OneToOne|ManyToMany|BelongsTo|HasMany|HasOne|ForeignKey)\s*\(\s*\(\)\s*=>\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
            addRelation(m[1], rm[1], 'orm')
          }
        }
      }
      if (/\.(?:java|kt|kts)$/i.test(low) && /@(?:Entity|Table)\b/.test(text)) {
        for (const m of text.matchAll(/@(?:Entity|Table)(?:\s*\([^)]*\))?(?:\s*@[A-Za-z_][A-Za-z0-9_]*(?:\s*\([^)]*\))?)*\s*(?:(?:public|internal|open|data|abstract|final)\s+)*class\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*\(([\s\S]*?)\))?[^{;\n]*(?:\{([\s\S]*?)\n\})?/g)) {
          const entityName = m[1]
          const combined = `${m[2] || ''}\n${m[3] || ''}`
          const cols = []
          for (const cm of combined.matchAll(/\b(?:private|protected|public)\s+(?:final\s+)?([A-Za-z0-9_<>, ?]+?)\s+([a-z_][A-Za-z0-9_]*)\s*(?:=|;)/g)) {
            cols.push(`${cm[2]}:${cm[1].trim()}`)
          }
          for (const km of combined.matchAll(/\b(?:val|var)\s+([a-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z0-9_<>?]+)/g)) {
            cols.push(`${km[1]}:${km[2]}`)
          }
          addEntity(entityName, rel, cols)
          for (const rm of combined.matchAll(/@(?:ManyToOne|OneToMany|OneToOne|ManyToMany)(?:\s*\([^)]*\))?(?:\s*@[A-Za-z_][A-Za-z0-9_]*(?:\s*\([^)]*\))?)*\s*(?:(?:private|protected|public|val|var)\s+)+(?:[a-z_][A-Za-z0-9_]*\s*:\s*)?(?:(?:List|Set|Collection|MutableList|MutableSet)\s*<\s*)?([A-Z][A-Za-z0-9_]*)/g)) {
            addRelation(entityName, rm[1], 'jpa')
          }
        }
      }
      if (/\.(?:ts|tsx|js|mjs)$/i.test(low) && /\b(?:pgTable|mysqlTable|sqliteTable)\s*\(/.test(text)) {
        for (const m of text.matchAll(/\b(?:pgTable|mysqlTable|sqliteTable)\s*\(\s*['"]([A-Za-z0-9_]+)['"]\s*,\s*\{([\s\S]*?)\}\s*\)/g)) {
          const cols = [...m[2].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((c) => c[1])
          addEntity(m[1], rel, cols)
          for (const rm of m[2].matchAll(/\.references\s*\(\s*\(\)\s*=>\s*([A-Za-z_][A-Za-z0-9_]*)\./g)) {
            addRelation(m[1], rm[1], 'fk')
          }
        }
      }
      if (low.endsWith('.py') && /__tablename__\s*=/.test(text)) {
        for (const m of text.matchAll(/class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*:([\s\S]*?)(?=\nclass\s|\n[^\s]|$)/g)) {
          if (!/__tablename__\s*=/.test(m[2])) continue
          const cols = [
            ...[...m[2].matchAll(/^\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*[^\n=]+)?\s*=\s*(?:[A-Za-z_][A-Za-z0-9_]*\.)?(?:Column|mapped_column)\s*\(/gm)].map((c) => c[1]),
            ...[...m[2].matchAll(/^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*Mapped\s*\[/gm)].map((c) => c[1]),
          ]
          addEntity(m[1], rel, cols)
          for (const rm of m[2].matchAll(/ForeignKey\s*\(\s*['"](?:[A-Za-z0-9_]+\.)?([A-Za-z0-9_]+)\.[A-Za-z0-9_]+['"]/g)) addRelation(m[1], rm[1], 'fk')
        }
      }
      if (low.endsWith('.py') && /\bmodels\.Model\b/.test(text)) {
        for (const m of text.matchAll(/class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\bmodels\.Model\b[^)]*\)\s*:([\s\S]*?)(?=\nclass\s|\n[^\s]|$)/g)) {
          const modelName = m[1]
          const cols = [...m[2].matchAll(/^\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*models\.([A-Za-z_][A-Za-z0-9_]*(?:Field|Key))\s*\(/gm)].map((c) => `${c[1]}:${c[2]}`)
          addEntity(modelName, rel, cols)
          for (const rm of m[2].matchAll(/^\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*models\.(?:ForeignKey|OneToOneField|ManyToManyField)\s*\(\s*(?:['"]([A-Za-z0-9_.]+)['"]|([A-Z][A-Za-z0-9_]*))/gm)) {
            const target = (rm[2] || rm[3] || '').split('.').pop()
            if (target && target !== 'self') addRelation(modelName, target, rm[1])
          }
        }
      }
      if (low.endsWith('.rb') && /\bcreate_table\b|\badd_foreign_key\b/.test(text)) {
        for (const m of text.matchAll(/\bcreate_table\s+["':]([A-Za-z0-9_]+)["']?[^\n]*\bdo\s*\|\s*([A-Za-z_][A-Za-z0-9_]*)\s*\|([\s\S]*?)\n\s*end\b/g)) {
          const tbl = m[1]
          const varName = m[2]
          const colRe = new RegExp(`\\b${varName}\\.([a-z_][a-z0-9_]*)\\s+["':]([A-Za-z0-9_]+)`, 'g')
          const cols = []
          for (const cm of m[3].matchAll(colRe)) {
            if (cm[1] === 'index') continue
            cols.push(`${cm[2]}:${cm[1]}`)
            if (cm[1] === 'references' || cm[1] === 'belongs_to') addRelation(tbl, cm[2], 'fk')
          }
          addEntity(tbl, rel, cols)
        }
        for (const fm of text.matchAll(/\badd_foreign_key\s+["':]([A-Za-z0-9_]+)["']?\s*,\s*["':]([A-Za-z0-9_]+)["']?/g)) {
          addRelation(fm[1], fm[2], 'fk')
        }
      }
      if (low.endsWith('.go') && /gorm:"/.test(text)) {
        for (const m of text.matchAll(/type\s+([A-Za-z_][A-Za-z0-9_]*)\s+struct\s*\{([\s\S]*?)\}/g)) {
          if (!/gorm:"/.test(m[2])) continue
          const cols = [...m[2].matchAll(/^\s*([A-Z][A-Za-z0-9_]*)\s+[^\n]*gorm:"/gm)].map((c) => c[1])
          addEntity(m[1], rel, cols)
        }
      }
      if (low.endsWith('.rs') && /\btable!\s*\{/.test(text)) {
        for (const m of text.matchAll(/\btable!\s*\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*\{([\s\S]*?)\}\s*\}/g)) {
          const cols = [...m[2].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*->/gm)].map((c) => c[1])
          addEntity(m[1], rel, cols)
        }
      }
    }
  }

  const list = [...entities.values()].sort((a, b) => a.name.localeCompare(b.name))
  const totalFields = list.reduce((sum, e) => sum + e.fields.length, 0)
  const active = list.length >= 1 && (totalFields > 0 || relations.length > 0)
  return {
    active,
    reason: active ? `发现 ${list.length} 个实体、${totalFields} 个字段与 ${relations.length} 条关系` : '未发现有效 Schema/SQL/ORM 实体定义',
    threshold: '>=1 entity with fields or relations',
    data: { id: 'erd', tier: 2, entities: list, relations },
  }
}
