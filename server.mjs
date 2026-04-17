import express from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import multer from 'multer'
import * as XLSX from 'xlsx'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEV_VARS_PATH = path.join(__dirname, '.dev.vars')
const PLATE_DB_PATH = path.join(__dirname, 'plate_db.json')   // 멀티파일 메타 저장
const DRAWING_DB_PATH = path.join(__dirname, 'drawing_db.json')

const app = express()
app.use(express.json({ limit: '20mb' }))
app.use(express.static(path.join(__dirname, 'public')))

// multer - 메모리에 Excel 파일 저장
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

// ─── .dev.vars 파일 로드/저장 ─────────────────────────────────────────────────
function loadDevVars() {
  try {
    if (fs.existsSync(DEV_VARS_PATH)) {
      const content = fs.readFileSync(DEV_VARS_PATH, 'utf8')
      const keyMatch = content.match(/^OPENAI_API_KEY\s*=\s*(.+)$/m)
      const urlMatch = content.match(/^OPENAI_BASE_URL\s*=\s*(.+)$/m)
      return {
        apiKey: keyMatch ? keyMatch[1].trim() : '',
        baseURL: urlMatch ? urlMatch[1].trim() : 'https://api.openai.com/v1'
      }
    }
  } catch(e) { console.error('[dev.vars] load error:', e.message) }
  return { apiKey: '', baseURL: 'https://api.openai.com/v1' }
}

function saveDevVars(apiKey, baseURL) {
  try {
    const content = `OPENAI_API_KEY=${apiKey}\nOPENAI_BASE_URL=${baseURL}\n`
    fs.writeFileSync(DEV_VARS_PATH, content, 'utf8')
    return true
  } catch(e) { console.error('[dev.vars] save error:', e.message); return false }
}

// ─── 런타임 저장소 ────────────────────────────────────────────────────────────
const initConfig = loadDevVars()
let runtimeApiKey = initConfig.apiKey || process.env.OPENAI_API_KEY || ''
let runtimeBaseURL = initConfig.baseURL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
if (runtimeApiKey) console.log(`[startup] API Key loaded: ${runtimeApiKey.slice(0,12)}...`)

// ─── DB 구조 ──────────────────────────────────────────────────────────────────
/**
 * plateDB: Plate Number DB — 멀티 파일 관리
 *   files: [{ fileId, filename, uploadedAt, entries: [{plateNo, heatNo, type}], alphaCount, numericCount }]
 *   (entries 전체는 getAllPlateEntries()로 집계)
 *
 * drawingDB: Drawing Number DB (단일 파일)
 *   entries: [{ drawingBase, sectionCode, skirtNo, drawingFull }]
 */
let plateDB = { files: [], updatedAt: null }   // files 배열로 멀티파일 관리
let drawingDB = { entries: [], updatedAt: null, filename: null }

/** 모든 파일에서 plate entries 집계 (plateNo 기준 중복 제거) */
function getAllPlateEntries() {
  const seen = new Set()
  const all = []
  for (const f of plateDB.files) {
    for (const e of f.entries) {
      if (!seen.has(e.plateNo)) { seen.add(e.plateNo); all.push(e) }
    }
  }
  return all
}

function loadDBs() {
  try {
    if (fs.existsSync(PLATE_DB_PATH)) {
      const raw = JSON.parse(fs.readFileSync(PLATE_DB_PATH, 'utf8'))
      // 구버전(entries 배열) 호환: 자동 마이그레이션
      if (Array.isArray(raw.entries) && !raw.files) {
        plateDB = { files: [], updatedAt: raw.updatedAt }
        console.log('[plateDB] Legacy format detected, migrated to multi-file structure')
      } else {
        plateDB = raw
      }
      console.log(`[plateDB] Loaded ${plateDB.files?.length || 0} file(s), ${getAllPlateEntries().length} total entries`)
    }
  } catch(e) { console.error('[plateDB] load error:', e.message) }
  try {
    if (fs.existsSync(DRAWING_DB_PATH)) {
      drawingDB = JSON.parse(fs.readFileSync(DRAWING_DB_PATH, 'utf8'))
      console.log(`[drawingDB] Loaded ${drawingDB.entries.length} entries`)
    }
  } catch(e) { console.error('[drawingDB] load error:', e.message) }
}
loadDBs()

// ─── 기본 프롬프트 ────────────────────────────────────────────────────────────
const DEFAULT_PROMPTS = {
  standard: `You are an OCR specialist for steel plate dot-matrix stamped text.

Read EXACTLY 3 lines from the image:

LINE 1 - Plate Number (Heat Number):
  Two formats exist:
  Format A (alphanumeric): [A|B][digit][LETTER][3digits]-[LETTER][2digits]-A[2digits]
    Examples: B5L779-C12-A01, A5H217-C13-A01, B5G610-C14-A02
    IMPORTANT: First character is ONLY 'A' or 'B' (never 8, 6, 0)
  Format B (numeric): [7digits]-[2digits]-[1digit]-[2digits]
    Examples: 5606726-01-1-01, 5606727-02-1-03

LINE 2 - Material grade + manufacturer:
  Format: S355J0+N or S355J2+N  then  SSAB
  Example: S355J0+N   SSAB

LINE 3 - Drawing number:
  Format: exactly 8 digits + hyphen + [B,L,M,U,W,T] + [01-11]
  Example: 29308316-B01, 29311971-T11

Return ONLY valid JSON (no markdown, no explanation):
{"line1":"...","line2":"...","line3":"...","confidence":0.0,"notes":"brief quality note"}`,

  agentic: `You are an expert OCR agent for industrial steel plate markings (타각/도트매트릭스).
{{HINT}}
{{CANDIDATES}}

STRICT RULES:

LINE 1 - Plate Number (Heat Number): Two formats:
  Format A (alphanumeric): [A|B][1digit][1LETTER][3digits]-[1LETTER][2digits]-A[2digits]
    - ONLY 'A' or 'B' as first char (NOT 8/6/0 — common misread in dot-matrix)
    - Valid examples: B5L779-C12-A01, A5G334-A30-A01, B5I552-D15-A01
  Format B (numeric): [7digits]-[2digits]-[1digit]-[2digits]
    - Examples: 5606726-01-1-01, 5606727-02-1-03

LINE 2 - Steel grade: must be "S355J0+N" or "S355J2+N" followed by "SSAB"

LINE 3 - Drawing number: exactly 8 digits + "-" + one of [B,L,M,U,W,T] + two digits 01-11
  - e.g. 29308316-B01, 29303342-B03, 29308299-T03

The image may be rotated — read from correct orientation.
Dot-matrix characters: 0 vs O, 1 vs I, 8 vs B, 5 vs S — choose based on position rules.

Return ONLY JSON:
{"line1":"...","line2":"...","line3":"...","confidence":0.0,"notes":"detailed analysis of ambiguous chars"}`
}

let runtimePrompts = { ...DEFAULT_PROMPTS }

// ─── Plate Number 파싱 유틸 ───────────────────────────────────────────────────
/**
 * Plate Number에서 Heat Number 추출
 * Format A: B5G610-C14-A02  → heatNo=B5G610
 * Format B: 5606726-01-1-01 → heatNo=5606726
 */
function extractHeatNumber(plateNo) {
  if (!plateNo) return null
  const p = plateNo.trim().toUpperCase()
  // Format A: 알파뉴메릭 (A|B로 시작)
  const matchA = p.match(/^([A-B]\d[A-Z]\d{3})-/)
  if (matchA) return matchA[1]
  // Format B: 숫자형 (7자리 숫자로 시작)
  const matchB = p.match(/^(\d{7})-/)
  if (matchB) return matchB[1]
  return null
}

function getPlateType(plateNo) {
  if (!plateNo) return 'unknown'
  const p = plateNo.trim().toUpperCase()
  if (/^[AB]\d[A-Z]\d{3}-/.test(p)) return 'alpha'
  if (/^\d{7}-/.test(p)) return 'numeric'
  return 'unknown'
}

// ─── Excel 파싱: Plate Number DB ─────────────────────────────────────────────
/**
 * Excel 파일에서 Plate Number DB 파싱
 * 컬럼 G (인덱스 6) = Plate No
 */
function parsePlateExcel(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })

  if (rows.length < 2) throw new Error('Excel에 데이터가 없습니다')

  // 헤더 행 찾기 (첫 번째 행 또는 "Plate No" 포함 행)
  let headerRowIdx = 0
  let colGIdx = 6  // 기본값: 컬럼 G (0-indexed)
  
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const rowStr = rows[i].map(c => String(c || '').toLowerCase())
    const plateColIdx = rowStr.findIndex(c => c.includes('plate') && (c.includes('no') || c.includes('num')))
    if (plateColIdx >= 0) {
      headerRowIdx = i
      colGIdx = plateColIdx
      break
    }
  }

  console.log(`[parsePlateExcel] headerRow=${headerRowIdx}, plateCol=${colGIdx} (${String.fromCharCode(65 + colGIdx)})`)

  const entries = []
  let skipped = 0

  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i]
    const rawPlate = String(row[colGIdx] || '').trim()
    if (!rawPlate) { skipped++; continue }

    const heatNo = extractHeatNumber(rawPlate)
    const type = getPlateType(rawPlate)

    if (!heatNo) { skipped++; continue }

    entries.push({
      plateNo: rawPlate.toUpperCase(),
      heatNo: heatNo.toUpperCase(),
      type
    })
  }

  // 중복 제거
  const unique = []
  const seen = new Set()
  for (const e of entries) {
    if (!seen.has(e.plateNo)) {
      seen.add(e.plateNo)
      unique.push(e)
    }
  }

  return { entries: unique, skipped }
}

// ─── Excel 파싱: Drawing Number DB ───────────────────────────────────────────
/**
 * Excel 파일에서 Drawing Number DB 파싱
 * 컬럼 D (인덱스 3) = Skirt Number (e.g. "u02" → 2)
 * 컬럼 F (인덱스 5) = Section Code (e.g. "B", "L", "U" 등)
 * 컬럼 G (인덱스 6) = Drawing Number (8자리 숫자, e.g. "29311969")
 */
function parseDrawingExcel(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })

  if (rows.length < 2) throw new Error('Excel에 데이터가 없습니다')

  // 컬럼 인덱스 감지 (헤더 행에서 찾기)
  let headerRowIdx = 0
  let colSkirt = 3, colSection = 5, colDrawing = 6  // 기본: D, F, G

  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const rowStr = rows[i].map(c => String(c || '').toLowerCase())
    const skirtIdx = rowStr.findIndex(c => c.includes('skirt'))
    const sectionIdx = rowStr.findIndex(c => c.includes('section') && (c.includes('code') || c.includes('type') || c === 'section code'))
    const drawingIdx = rowStr.findIndex(c => (c.includes('drawing') && c.includes('no')) || c === 'drawing number' || c === 'drawing no')

    if (skirtIdx >= 0 || drawingIdx >= 0) {
      headerRowIdx = i
      if (skirtIdx >= 0) colSkirt = skirtIdx
      if (sectionIdx >= 0) colSection = sectionIdx
      if (drawingIdx >= 0) colDrawing = drawingIdx
      break
    }
  }

  console.log(`[parseDrawingExcel] headerRow=${headerRowIdx}, skirt=${colSkirt}(${String.fromCharCode(65+colSkirt)}), section=${colSection}(${String.fromCharCode(65+colSection)}), drawing=${colDrawing}(${String.fromCharCode(65+colDrawing)})`)

  const SECTION_CODE_MAP = {
    'b': 'B', 'bot': 'B', 'bottom': 'B',
    'l': 'L', 'l1': 'L', 'mid1': 'L', 'mid.1': 'L', 'mid 1': 'L',
    'm': 'M', 'l2': 'M', 'mid2': 'M', 'mid.2': 'M', 'mid 2': 'M',
    'u': 'U', 'l3': 'U', 'mid3': 'U', 'mid.3': 'U', 'mid 3': 'U',
    'w': 'W', 'l4': 'W', 'mid4': 'W', 'mid.4': 'W', 'mid 4': 'W',
    't': 'T', 'top': 'T'
  }

  const entries = []
  let skipped = 0

  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i]

    // Drawing Number 파싱
    const rawDrawing = String(row[colDrawing] || '').trim().replace(/\s/g, '')
    if (!rawDrawing) { skipped++; continue }

    // 8자리 숫자 추출
    const drawingBase = rawDrawing.replace(/\D/g, '').slice(0, 8)
    if (drawingBase.length !== 8) { skipped++; continue }

    // Section Code 파싱
    let rawSection = String(row[colSection] || '').trim().toLowerCase()
    let sectionCode = SECTION_CODE_MAP[rawSection] || rawSection.toUpperCase().slice(0, 1)
    if (!['B','L','M','U','W','T'].includes(sectionCode)) {
      // Drawing Number 자체에서 추출 시도 (e.g. "29311969-U02")
      const m = rawDrawing.match(/-([BLMUWT])(\d{2})$/)
      if (m) sectionCode = m[1]
      else { skipped++; continue }
    }

    // Skirt Number 파싱 (e.g. "u02" → 2, "02" → 2, "2" → 2)
    const rawSkirt = String(row[colSkirt] || '').trim()
    const skirtMatch = rawSkirt.match(/(\d+)/)
    if (!skirtMatch) { skipped++; continue }
    const skirtNo = parseInt(skirtMatch[1])

    // Drawing 전체 번호 조합
    const drawingFull = `${drawingBase}-${sectionCode}${String(skirtNo).padStart(2, '0')}`

    entries.push({ drawingBase, sectionCode, skirtNo, drawingFull })
  }

  // 중복 제거 (drawingFull 기준)
  const unique = []
  const seen = new Set()
  for (const e of entries) {
    if (!seen.has(e.drawingFull)) {
      seen.add(e.drawingFull)
      unique.push(e)
    }
  }

  return { entries: unique, skipped }
}

// ─── 매칭 엔진 ───────────────────────────────────────────────────────────────
/**
 * OCR 결과와 두 DB를 매칭
 * @param {string} ocrLine1 - OCR Plate/Heat Number
 * @param {string} ocrLine3 - OCR Drawing Number
 * @returns {{ plateMatch, drawingMatch, combined }}
 */
function matchWithDBs(ocrLine1, ocrLine3) {
  const result = {
    plateMatch: null,
    drawingMatch: null,
    combined: { matched: false, confidence: 0, method: 'no_match' }
  }

  const normalize = s => (s || '').toUpperCase().replace(/\s/g, '')
  const ocr1 = normalize(ocrLine1)
  const ocr3 = normalize(ocrLine3)

  // ─── Plate DB 매칭 (멀티파일 집계 entries 사용) ──────────────────────────
  const allPlateEntries = getAllPlateEntries()
  if (allPlateEntries.length > 0 && ocr1) {
    // 전략 1: plateNo 완전 매칭
    let found = allPlateEntries.find(e => e.plateNo === ocr1)
    if (found) {
      result.plateMatch = { matched: true, entry: found, confidence: 1.0, method: 'plate_exact' }
    } else {
      // 전략 2: heatNo 완전 매칭
      const ocrHeat = extractHeatNumber(ocrLine1)?.toUpperCase()
      if (ocrHeat) {
        const byHeat = allPlateEntries.filter(e => e.heatNo === ocrHeat)
        if (byHeat.length > 0) {
          result.plateMatch = { matched: true, entry: byHeat[0], allByHeat: byHeat, confidence: 0.95, method: 'heat_exact' }  // Heat만 일치
        }
      }

      if (!result.plateMatch) {
        // 전략 3: 퍼지 매칭 (Plate No 유사도)
        let bestPlate = { entry: null, score: 0 }
        for (const e of allPlateEntries) {
          const score = stringSimilarity(ocr1, e.plateNo)
          if (score > bestPlate.score) bestPlate = { entry: e, score }
        }
        let bestHeat = { entry: null, score: 0 }
        for (const e of allPlateEntries) {
          const score = stringSimilarity(ocr1, e.heatNo)
          if (score > bestHeat.score) bestHeat = { entry: e, score }
        }
        const best = bestPlate.score >= bestHeat.score ? bestPlate : bestHeat

        if (best.score >= 0.8) {
          result.plateMatch = { matched: true, entry: best.entry, confidence: 0.75 + best.score * 0.15, method: 'plate_fuzzy', fuzzyScore: best.score }
        }
      }
    }
  }

  // ─── Drawing DB 매칭 ──────────────────────────────────────────────────────
  if (drawingDB.entries.length > 0 && ocr3) {
    // 전략 1: drawingFull 완전 매칭
    const found = drawingDB.entries.find(e => e.drawingFull === ocr3)
    if (found) {
      result.drawingMatch = { matched: true, entry: found, confidence: 1.0, method: 'drawing_exact' }
    } else {
      // 전략 2: drawingBase만 매칭
      const m = ocr3.match(/^(\d{8})-([BLMUWT])(\d{2})$/)
      if (m) {
        const [, base, code, skirt] = m
        const byBase = drawingDB.entries.find(e => e.drawingBase === base && e.sectionCode === code)
        if (byBase) {
          result.drawingMatch = { matched: true, entry: byBase, confidence: 0.95, method: 'drawing_base_match' }  // 기본번호 일치
        }
      }

      if (!result.drawingMatch) {
        // 전략 3: 퍼지 매칭 (Drawing Full 유사도)
        let best = { entry: null, score: 0 }
        for (const e of drawingDB.entries) {
          const score = stringSimilarity(ocr3, e.drawingFull)
          if (score > best.score) best = { entry: e, score }
        }
        if (best.score >= 0.8) {
          result.drawingMatch = { matched: true, entry: best.entry, confidence: 0.70, method: 'drawing_fuzzy', fuzzyScore: best.score }
        }
      }
    }
  }

  // ─── 통합 신뢰도 계산 ─────────────────────────────────────────────────────
  // combined.confidence = "DB 매칭 자체의 신뢰도"
  // 각 DB가 독립적으로 매칭되므로, 매칭된 것들의 신뢰도를 그대로 반영
  // plate_exact / drawing_exact = 1.0 (DB에 정확히 존재)
  // 한쪽만 매칭되어도 해당 신뢰도를 그대로 사용 (× 0.85 패널티 제거)
  if (result.plateMatch?.matched && result.drawingMatch?.matched) {
    result.combined = {
      matched: true,
      confidence: (result.plateMatch.confidence * 0.5 + result.drawingMatch.confidence * 0.5),
      method: `${result.plateMatch.method}+${result.drawingMatch.method}`
    }
  } else if (result.plateMatch?.matched) {
    result.combined = { matched: true, confidence: result.plateMatch.confidence, method: result.plateMatch.method }
  } else if (result.drawingMatch?.matched) {
    result.combined = { matched: true, confidence: result.drawingMatch.confidence, method: result.drawingMatch.method }
  }

  return result
}

// 두 문자열의 유사도 (0~1)
function stringSimilarity(a, b) {
  if (!a || !b) return 0
  const longer = a.length > b.length ? a : b
  const shorter = a.length > b.length ? b : a
  if (longer.length === 0) return 1.0
  return (longer.length - editDistance(longer, shorter)) / longer.length
}

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i])
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1])
    }
  }
  return dp[a.length][b.length]
}

// ─── POST /api/config ─────────────────────────────────────────────────────────
app.post('/api/config', (req, res) => {
  const { apiKey, baseURL, persist } = req.body
  if (!apiKey) return res.status(400).json({ error: 'apiKey required' })
  runtimeApiKey = apiKey.trim()
  runtimeBaseURL = (baseURL || 'https://api.openai.com/v1').trim()
  let persisted = false
  if (persist) persisted = saveDevVars(runtimeApiKey, runtimeBaseURL)
  console.log(`[config] API Key set: ${runtimeApiKey.slice(0,15)}... persist=${persisted}`)
  res.json({ ok: true, persisted })
})

// ─── GET /api/config/status ───────────────────────────────────────────────────
app.get('/api/config/status', (req, res) => {
  const devVarsExists = fs.existsSync(DEV_VARS_PATH)
  let persisted = false
  if (devVarsExists) {
    try { persisted = fs.readFileSync(DEV_VARS_PATH, 'utf8').includes('OPENAI_API_KEY=') } catch(e) {}
  }
  res.json({
    configured: !!runtimeApiKey,
    keyPreview: runtimeApiKey ? runtimeApiKey.slice(0, 4) + '...' + runtimeApiKey.slice(-4) : '',
    persisted
  })
})

// ─── GET /api/prompts ─────────────────────────────────────────────────────────
app.get('/api/prompts', (req, res) => {
  res.json({ standard: runtimePrompts.standard, agentic: runtimePrompts.agentic, defaults: DEFAULT_PROMPTS })
})

// ─── POST /api/prompts ────────────────────────────────────────────────────────
app.post('/api/prompts', (req, res) => {
  const { type, prompt } = req.body
  if (!type || !['standard', 'agentic'].includes(type)) return res.status(400).json({ error: 'type must be "standard" or "agentic"' })
  if (!prompt || prompt.trim().length < 10) return res.status(400).json({ error: 'prompt too short' })
  runtimePrompts[type] = prompt.trim()
  console.log(`[prompts] ${type} updated (${prompt.length} chars)`)
  res.json({ ok: true, type, length: prompt.length })
})

// ─── POST /api/prompts/reset ──────────────────────────────────────────────────
app.post('/api/prompts/reset', (req, res) => {
  const { type } = req.body
  if (type === 'standard') runtimePrompts.standard = DEFAULT_PROMPTS.standard
  else if (type === 'agentic') runtimePrompts.agentic = DEFAULT_PROMPTS.agentic
  else runtimePrompts = { ...DEFAULT_PROMPTS }
  res.json({ ok: true })
})

// ─── POST /api/db/plate/upload (Excel 업로드 — 멀티파일) ─────────────────────
app.post('/api/db/plate/upload', upload.array('files', 50), (req, res) => {
  try {
    const uploadedFiles = req.files
    if (!uploadedFiles?.length) return res.status(400).json({ error: '파일이 없습니다' })

    const results = []
    const errors = []

    for (const file of uploadedFiles) {
      const filename = file.originalname
      // 이미 같은 파일명 존재 시 덮어쓰기
      const existingIdx = plateDB.files.findIndex(f => f.filename === filename)

      try {
        const { entries, skipped } = parsePlateExcel(file.buffer)
        if (!entries.length) { errors.push({ filename, error: 'Plate Number를 찾을 수 없습니다' }); continue }

        const alphaCount = entries.filter(e => e.type === 'alpha').length
        const numericCount = entries.filter(e => e.type === 'numeric').length
        const fileId = `${Date.now()}_${Math.random().toString(36).slice(2,7)}`
        const fileRecord = { fileId, filename, uploadedAt: new Date().toISOString(), entries, alphaCount, numericCount, skipped }

        if (existingIdx >= 0) {
          plateDB.files[existingIdx] = fileRecord
          console.log(`[plateDB] Updated: ${filename} (${entries.length} entries)`)
        } else {
          plateDB.files.push(fileRecord)
          console.log(`[plateDB] Added: ${filename} (${entries.length} entries)`)
        }
        results.push({ filename, count: entries.length, alphaCount, numericCount, skipped, replaced: existingIdx >= 0 })
      } catch(e) {
        errors.push({ filename, error: e.message })
      }
    }

    plateDB.updatedAt = new Date().toISOString()
    fs.writeFileSync(PLATE_DB_PATH, JSON.stringify(plateDB, null, 2), 'utf8')

    const totalEntries = getAllPlateEntries().length
    res.json({ ok: true, uploaded: results, errors, totalFiles: plateDB.files.length, totalEntries })
  } catch(e) {
    console.error('[plateDB] upload error:', e.message)
    res.status(400).json({ error: e.message })
  }
})

// ─── DELETE /api/db/plate/file/:fileId (개별 파일 삭제) ──────────────────────
app.delete('/api/db/plate/file/:fileId', (req, res) => {
  const { fileId } = req.params
  const idx = plateDB.files.findIndex(f => f.fileId === fileId)
  if (idx < 0) return res.status(404).json({ error: '파일을 찾을 수 없습니다' })
  const removed = plateDB.files.splice(idx, 1)[0]
  plateDB.updatedAt = new Date().toISOString()
  fs.writeFileSync(PLATE_DB_PATH, JSON.stringify(plateDB, null, 2), 'utf8')
  console.log(`[plateDB] Removed file: ${removed.filename}`)
  const totalEntries = getAllPlateEntries().length
  res.json({ ok: true, removed: removed.filename, totalFiles: plateDB.files.length, totalEntries })
})

// ─── GET /api/db/plate/files (파일 목록 조회) ─────────────────────────────────
app.get('/api/db/plate/files', (req, res) => {
  const files = plateDB.files.map(f => ({
    fileId: f.fileId,
    filename: f.filename,
    uploadedAt: f.uploadedAt,
    count: f.entries.length,
    alphaCount: f.alphaCount,
    numericCount: f.numericCount,
    skipped: f.skipped
  }))
  res.json({ files, totalFiles: files.length, totalEntries: getAllPlateEntries().length })
})

// ─── POST /api/db/drawing/upload (Excel 업로드) ───────────────────────────────
app.post('/api/db/drawing/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '파일이 없습니다' })
    const filename = req.file.originalname
    console.log(`[drawingDB] Uploading: ${filename} (${req.file.size} bytes)`)

    const { entries, skipped } = parseDrawingExcel(req.file.buffer)
    if (!entries.length) return res.status(400).json({ error: 'Drawing Number를 찾을 수 없습니다. 컬럼 D(Skirt No), F(Section Code), G(Drawing No)를 확인해주세요.' })

    drawingDB = { entries, updatedAt: new Date().toISOString(), filename }
    fs.writeFileSync(DRAWING_DB_PATH, JSON.stringify(drawingDB, null, 2), 'utf8')

    console.log(`[drawingDB] Saved ${entries.length} entries, skipped:${skipped}`)
    res.json({ ok: true, count: entries.length, skipped, sample: entries.slice(0, 3) })
  } catch(e) {
    console.error('[drawingDB] upload error:', e.message)
    res.status(400).json({ error: e.message })
  }
})

// ─── DELETE /api/db/plate (전체 초기화) ──────────────────────────────────────
app.delete('/api/db/plate', (req, res) => {
  plateDB = { files: [], updatedAt: null }
  if (fs.existsSync(PLATE_DB_PATH)) fs.unlinkSync(PLATE_DB_PATH)
  res.json({ ok: true })
})

// ─── DELETE /api/db/drawing ───────────────────────────────────────────────────
app.delete('/api/db/drawing', (req, res) => {
  drawingDB = { entries: [], updatedAt: null, filename: null }
  if (fs.existsSync(DRAWING_DB_PATH)) fs.unlinkSync(DRAWING_DB_PATH)
  res.json({ ok: true })
})

// ─── GET /api/db/status ───────────────────────────────────────────────────────
app.get('/api/db/status', (req, res) => {
  const allPlateEntries = getAllPlateEntries()
  const plateSample = allPlateEntries.slice(0, 3).map(e => e.plateNo)
  const drawingSample = drawingDB.entries.slice(0, 3).map(e => e.drawingFull)
  res.json({
    plate: {
      loaded: allPlateEntries.length > 0,
      count: allPlateEntries.length,
      fileCount: plateDB.files.length,
      updatedAt: plateDB.updatedAt,
      alphaCount: allPlateEntries.filter(e => e.type === 'alpha').length,
      numericCount: allPlateEntries.filter(e => e.type === 'numeric').length,
      sample: plateSample
    },
    drawing: {
      loaded: drawingDB.entries.length > 0,
      count: drawingDB.entries.length,
      updatedAt: drawingDB.updatedAt,
      filename: drawingDB.filename,
      sample: drawingSample
    }
  })
})

// ─── POST /api/db/match (매칭 테스트) ────────────────────────────────────────
app.post('/api/db/match', (req, res) => {
  const { line1, line3 } = req.body
  const result = matchWithDBs(line1, line3)
  res.json(result)
})

// ─── API Key 로드 ─────────────────────────────────────────────────────────────
function getApiConfig() {
  if (runtimeApiKey) return { apiKey: runtimeApiKey, baseURL: runtimeBaseURL }
  return { apiKey: '', baseURL: 'https://api.openai.com/v1' }
}

// ─── 패턴 검증 ────────────────────────────────────────────────────────────────
function validatePlateNumber(val = '') {
  const cleaned = val.toUpperCase().replace(/\s/g, '')
  // Format A: 알파뉴메릭
  const validA = /^[AB]\d[A-Z]\d{3}-[A-Z]\d{2}-[AB]\d{2}$/.test(cleaned)
  // Format B: 숫자형
  const validB = /^\d{7}-\d{2}-\d{1}-\d{2}$/.test(cleaned)
  return { valid: validA || validB, corrected: cleaned, format: validA ? 'alpha' : validB ? 'numeric' : 'unknown' }
}
function validateMaterial(val = '') {
  const cleaned = val.toUpperCase().replace(/\s+/g, ' ').trim()
  return { valid: /S355J[02]\+N/.test(cleaned) && cleaned.includes('SSAB'), corrected: cleaned }
}
function validateDrawingNumber(val = '') {
  const cleaned = val.toUpperCase().replace(/\s/g, '')
  return { valid: /^\d{8}-[BLMUWT](0[1-9]|1[01])$/.test(cleaned), corrected: cleaned }
}
function calcDifficulty(confidence = 0) {
  if (confidence >= 0.95) return 1
  if (confidence >= 0.85) return 2
  if (confidence >= 0.75) return 3
  if (confidence >= 0.65) return 4
  if (confidence >= 0.55) return 5
  if (confidence >= 0.45) return 6
  if (confidence >= 0.35) return 7
  if (confidence >= 0.25) return 8
  if (confidence >= 0.15) return 9
  return 10
}

// ─── OpenAI Vision 호출 ───────────────────────────────────────────────────────
async function callVision(imageBase64, prompt, model) {
  const { apiKey, baseURL } = getApiConfig()
  if (!apiKey) throw new Error('API Key가 설정되지 않았습니다. 우상단 설정 버튼을 클릭해 주세요.')
  console.log(`[OCR] model=${model} key=${apiKey.slice(0, 12)}...`)

  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}`, detail: 'high' } }
      ]}],
      max_completion_tokens: 500,
      temperature: 0.05,
    })
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`API Error ${response.status}: ${err}`)
  }
  const data = await response.json()
  return data.choices?.[0]?.message?.content || '{}'
}

function parseOCR(raw) {
  try {
    const m = raw.match(/\{[\s\S]*\}/)
    return JSON.parse(m ? m[0] : raw)
  } catch {
    return { line1: '', line2: '', line3: '', confidence: 0, notes: raw.slice(0, 200) }
  }
}

function buildResult(parsed, method, elapsed, dbMatch = null) {
  const pv = validatePlateNumber(parsed.line1)
  const mv = validateMaterial(parsed.line2)
  const dv = validateDrawingNumber(parsed.line3)

  let finalLine1 = pv.corrected || parsed.line1 || ''
  let finalLine3 = dv.corrected || parsed.line3 || ''
  let refInfo = null

  if (dbMatch) {
    const { plateMatch, drawingMatch, combined } = dbMatch

    refInfo = {
      matched: combined.matched,
      confidence: combined.confidence,
      method: combined.method,
      plate: plateMatch?.matched ? {
        plateNo: plateMatch.entry?.plateNo,
        heatNo: plateMatch.entry?.heatNo,
        type: plateMatch.entry?.type,
        confidence: plateMatch.confidence,
        matchMethod: plateMatch.method
      } : null,
      drawing: drawingMatch?.matched ? {
        drawingFull: drawingMatch.entry?.drawingFull,
        drawingBase: drawingMatch.entry?.drawingBase,
        sectionCode: drawingMatch.entry?.sectionCode,
        skirtNo: drawingMatch.entry?.skirtNo,
        confidence: drawingMatch.confidence,
        matchMethod: drawingMatch.method
      } : null
    }

    // DB 결과로 보정
    if (plateMatch?.matched && plateMatch.entry?.plateNo) {
      finalLine1 = plateMatch.entry.plateNo
    }
    if (drawingMatch?.matched && drawingMatch.entry?.drawingFull) {
      finalLine3 = drawingMatch.entry.drawingFull
    }
  }

  const pv2 = validatePlateNumber(finalLine1)
  const dv2 = validateDrawingNumber(finalLine3)
  const score = [pv2.valid, mv.valid, dv2.valid].filter(Boolean).length / 3

  const baseConf = parsed.confidence || 0.5
  const refBoost = dbMatch?.combined?.matched ? dbMatch.combined.confidence * 0.3 : 0
  const conf = Math.round(Math.min(0.99, baseConf * 0.5 + score * 0.2 + refBoost) * 100) / 100

  return {
    method, elapsed,
    line1: finalLine1,
    line2: mv.corrected || parsed.line2 || '',
    line3: finalLine3,
    confidence: conf,
    difficulty: calcDifficulty(conf),
    validation: { heat: pv2.valid, material: mv.valid, drawing: dv2.valid },
    notes: parsed.notes || '',
    refMatch: refInfo
  }
}

// ─── POST /api/ocr/standard ───────────────────────────────────────────────────
app.post('/api/ocr/standard', async (req, res) => {
  const t0 = Date.now()
  try {
    const { imageBase64 } = req.body
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' })

    const raw = await callVision(imageBase64, runtimePrompts.standard, 'gpt-4o-mini')
    const parsed = parseOCR(raw)

    const dbMatch = matchWithDBs(parsed.line1, parsed.line3)

    res.json(buildResult(parsed, 'Standard (gpt-4o-mini)', `${((Date.now()-t0)/1000).toFixed(1)}s`, dbMatch))
  } catch (e) {
    console.error('[standard]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ─── POST /api/ocr/agentic ────────────────────────────────────────────────────
app.post('/api/ocr/agentic', async (req, res) => {
  const t0 = Date.now()
  try {
    const { imageBase64, standardResult } = req.body
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' })

    const hint = standardResult
      ? `Previous OCR pass read: line1="${standardResult.line1}", line2="${standardResult.line2}", line3="${standardResult.line3}". Verify and correct if needed.`
      : ''

    // Plate DB 후보군 삽입
    let candidatesBlock = ''
    const allPlateEntriesAg = getAllPlateEntries()
    if (allPlateEntriesAg.length > 0 || drawingDB.entries.length > 0) {
      const lines = []

      // Drawing DB에서 매칭되는 도면번호 찾기
      if (drawingDB.entries.length > 0 && standardResult?.line3) {
        const ocr3 = (standardResult.line3 || '').toUpperCase().replace(/\s/g, '')
        const drawMatch = drawingDB.entries.find(e => e.drawingFull === ocr3)
        if (drawMatch) {
          lines.push(`DRAWING DB MATCH: ${drawMatch.drawingFull} (Section: ${drawMatch.sectionCode}, Skirt: #${drawMatch.skirtNo})`)
          lines.push(`→ LINE 3 confirmed as: ${drawMatch.drawingFull}`)
        } else {
          const top3 = drawingDB.entries
            .map(e => ({ e, score: stringSimilarity(ocr3, e.drawingFull) }))
            .sort((a,b) => b.score - a.score)
            .slice(0, 3)
          if (top3[0]?.score >= 0.6) {
            lines.push(`DRAWING DB CANDIDATES (top matches):`)
            top3.forEach(({ e, score }) => lines.push(`  ${e.drawingFull} (${(score*100).toFixed(0)}% match)`))
          }
        }
      }

      // Plate DB에서 유사한 Plate Number 후보 (멀티파일 집계)
      if (allPlateEntriesAg.length > 0 && standardResult?.line1) {
        const ocr1 = (standardResult.line1 || '').toUpperCase().replace(/\s/g, '')
        const topPlates = allPlateEntriesAg
          .map(e => ({ e, score: Math.max(stringSimilarity(ocr1, e.plateNo), stringSimilarity(ocr1, e.heatNo)) }))
          .sort((a,b) => b.score - a.score)
          .slice(0, 8)
        if (topPlates.length > 0 && topPlates[0].score >= 0.5) {
          lines.push(`\nPLATE DB CANDIDATES for LINE 1 (top matches):`)
          topPlates.forEach(({ e, score }) => lines.push(`  ${e.plateNo} (Heat: ${e.heatNo}, ${(score*100).toFixed(0)}% match)`))
          lines.push(`→ LINE 1 should be one of the above plate numbers.`)
        }
      }

      if (lines.length > 0) {
        candidatesBlock = '\nREFERENCE DATABASE:\n' + lines.join('\n')
      }
    }

    const prompt = runtimePrompts.agentic
      .replace('{{HINT}}', hint)
      .replace('{{CANDIDATES}}', candidatesBlock)

    const raw = await callVision(imageBase64, prompt, 'gpt-4o')
    const parsed = parseOCR(raw)

    const dbMatch = matchWithDBs(parsed.line1, parsed.line3)

    res.json(buildResult(parsed, 'Agentic Vision (gpt-4o)', `${((Date.now()-t0)/1000).toFixed(1)}s`, dbMatch))
  } catch (e) {
    console.error('[agentic]', e.message)
    res.status(500).json({ error: e.message })
  }
})

app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')))

const PORT = process.env.PORT || 3000
app.listen(PORT, '0.0.0.0', () => console.log(`✅ Server running on http://0.0.0.0:${PORT}`))
