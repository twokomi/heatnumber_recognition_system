import express from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { execFile } from 'child_process'
import multer from 'multer'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEV_VARS_PATH = path.join(__dirname, '.dev.vars')
const UNIFIED_DB_PATH  = path.join(__dirname, 'unified_db.json')      // 메타 (파일목록, 통계)
const UNIFIED_ENT_PATH = path.join(__dirname, 'unified_entries.json')  // entries 별도 저장
// 레거시 파일 경로 (삭제용으로만 유지)
const PLATE_DB_PATH    = path.join(__dirname, 'plate_db.json')
const DRAWING_DB_PATH  = path.join(__dirname, 'drawing_db.json')

const app = express()
app.use(express.json({ limit: '20mb' }))
app.use(express.static(path.join(__dirname, 'public')))

// ─── 모바일 전용 페이지 ───────────────────────────────────────────────────────
app.get('/mobile', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'mobile.html'))
})

// multer - 메모리에 Excel 파일 저장
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } })

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

// ─── DB 구조 (통합 신규 형식) ───────────────────────────────────────────────
/**
 * unifiedDB: 통합 DB — 새 Excel(4 Projects SP Hardstamp Details) 형식
 *   files: [{ fileId, filename, uploadedAt, entries, plateCount, drawingCount }]
 *   entries per file: [{
 *     plateNo,      // PlateID 컬럼  e.g. 'B5K866-A04-A01' or '5605819-04-2-02'
 *     heatNo,       // Heats 컬럼    e.g. 'B5K866' or '5605819'
 *     type,         // 'alpha' | 'numeric'
 *     drawingFull,  // 조합 결과     e.g. '29311949-U07' or '29308304-B02'
 *     drawingBase,  // 8자리         e.g. '29311949'
 *     sectionCode,  // 1글자         e.g. 'U'
 *     skirtNo,      // 숫자          e.g. 7
 *     project,      // Project 컬럼 (참고용)
 *   }]
 *
 * 레거시 호환: getAllPlateEntries(), drawingDB.entries 형태로도 접근 가능
 */
let unifiedDB = { files: [], updatedAt: null }  // 메타만 (entries 제외)
let unifiedEntries = []  // 전체 entries 메모리 캐시

// 레거시 변수 (참조만 유지 — 실제 사용 안 함)
const plateDB  = { files: [], updatedAt: null }
const drawingDB = { entries: [], updatedAt: null, filename: null }

/** unifiedEntries에서 plateNo 중복 제거 목록 반환 */
function getAllPlateEntries() { return unifiedEntries }

/** drawingFull 중복 제거 목록 반환 */
function getAllDrawingEntries() {
  const seen = new Set()
  const all  = []
  for (const e of unifiedEntries) {
    if (e.drawingFull && !seen.has(e.drawingFull)) {
      seen.add(e.drawingFull)
      all.push({ drawingBase: e.drawingBase, sectionCode: e.sectionCode, skirtNo: e.skirtNo, drawingFull: e.drawingFull })
    }
  }
  return all
}

/** DB 저장 — meta와 entries를 분리 파일에 저장 */
function saveUnifiedDB() {
  // meta (entries 제외)
  const meta = {
    files: unifiedDB.files.map(f => ({ ...f, entries: undefined })),
    updatedAt: unifiedDB.updatedAt
  }
  fs.writeFileSync(UNIFIED_DB_PATH, JSON.stringify(meta), 'utf8')
  // entries 별도 저장
  fs.writeFileSync(UNIFIED_ENT_PATH, JSON.stringify(unifiedEntries), 'utf8')
}

function loadDBs() {
  // 신규 unified DB 로드
  if (fs.existsSync(UNIFIED_DB_PATH) && fs.existsSync(UNIFIED_ENT_PATH)) {
    try {
      unifiedDB      = JSON.parse(fs.readFileSync(UNIFIED_DB_PATH, 'utf8'))
      unifiedEntries = JSON.parse(fs.readFileSync(UNIFIED_ENT_PATH, 'utf8'))
      console.log(`[unifiedDB] Loaded ${unifiedDB.files?.length || 0} file(s), ${unifiedEntries.length} entries, ${getAllDrawingEntries().length} unique drawings`)
      return
    } catch(e) { console.error('[unifiedDB] load error:', e.message) }
  }
  // unified DB 없음 → 비어있는 상태로 시작 (레거시 마이그레이션 없음)
  console.log('[DB] No unified DB found. Please upload the new Excel file via /api/db/plate/upload')
}
loadDBs()

// ─── 기본 프롬프트 ────────────────────────────────────────────────────────────
const DEFAULT_PROMPTS = {
  standard: `You are an OCR specialist for steel plate dot-matrix stamped text.

There are TWO layout types. Detect which type and read accordingly:

━━ TYPE A (most common) ━━
  Line 1: Plate/Heat Number
  Line 2: Material grade
  Line 3: Drawing number

━━ TYPE B (new format) ━━
  Line 1: Drawing number (8 digits only, no hyphen)
  Line 2: Heat/Plate Number (numeric format)
  Line 3: Material grade (short form, e.g. "S355 J0")

FIELD FORMATS:

Plate Number (Heat Number):
  Format A (alphanumeric): [A|B][digit][LETTER][3digits]-[LETTER][2digits]-A[2digits]
    Examples: B5L779-C12-A01, A5H217-C13-A01
    IMPORTANT: First char is ONLY 'A' or 'B'
  Format B (numeric): [7digits]-[2digits]-[1digit]-[2digits]
    Examples: 5606726-01-1-01, 5600171-05-1-02

Material grade:
  Long form:  S355J0+N SSAB  or  S355J2+N SSAB
  Short form: S355J0  or  S355 J0  or  S355JO  (no SSAB)

Drawing number:
  With position:   8digits-[B,L,M,U,W,T][01-11]   e.g. 29308316-B01
  Without position (TYPE B line1): 8 digits only   e.g. 29308308

Return ONLY valid JSON:
{"line1":"...","line2":"...","line3":"...","layoutType":"A" or "B","confidence":0.0,"notes":"brief quality note"}`,

  agentic: `You are an expert OCR agent for industrial steel plate markings (타각/도트매트릭스).
{{HINT}}
{{CANDIDATES}}

There are TWO layout types:

━━ TYPE A (standard) ━━
  line1 = Plate/Heat Number (alphanumeric or numeric format)
  line2 = Material grade (S355J0+N SSAB or S355J2+N SSAB)
  line3 = Drawing number (8digits-LETTER+2digits)

━━ TYPE B (alternate) ━━
  line1 = Drawing number base (8 digits ONLY, no hyphen suffix)
  line2 = Plate/Heat Number (numeric: 7digits-2d-1d-2d)
  line3 = Material grade (short: S355J0 or S355 J0, may lack SSAB)
  Detection: if first line looks like a standalone 8-digit number → TYPE B

FIELD RULES:
Plate Number:
  Format A (alpha): [A|B][1digit][LETTER][3digits]-[LETTER][2digits]-A[2digits]
    First char MUST be A or B (not 8/6/0)
  Format B (numeric): [7digits]-[2digits]-[1digit]-[2digits]

Material: S355J0+N, S355J2+N, S355J0, S355 J0, S355JO — with or without SSAB

Drawing: 8digits + optional "-" + [B,L,M,U,W,T] + [01-11]

Dot-matrix: 0↔O, 1↔I, 8↔B, 5↔S — use position context.
Image may be rotated.

Return ONLY JSON:
{"line1":"...","line2":"...","line3":"...","layoutType":"A" or "B","confidence":0.0,"notes":"analysis"}`
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

// ─── 매칭 엔진 (unifiedDB 기반) ──────────────────────────────────────────────
/**
 * OCR 결과와 unifiedDB를 매칭
 * @param {string} ocrLine1 - 정규화된 Plate/Heat Number
 * @param {string} ocrLine3 - 정규화된 Drawing Number (full or base-only)
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

  const allEntries  = getAllPlateEntries()    // unified entries (plate+drawing 통합)
  const allDrawings = getAllDrawingEntries()  // drawing 전용 뷰

  // ─── Plate 매칭 ──────────────────────────────────────────────────────────
  if (allEntries.length > 0 && ocr1) {
    // 전략1: plateNo 완전 매칭
    let found = allEntries.find(e => e.plateNo === ocr1)
    if (found) {
      result.plateMatch = { matched: true, entry: found, confidence: 1.0, method: 'plate_exact' }
    } else {
      // 전략2: heatNo 완전 매칭
      const ocrHeat = extractHeatNumber(ocrLine1)?.toUpperCase()
      if (ocrHeat) {
        const byHeat = allEntries.filter(e => e.heatNo === ocrHeat)
        if (byHeat.length > 0) {
          result.plateMatch = { matched: true, entry: byHeat[0], allByHeat: byHeat, confidence: 0.95, method: 'heat_exact' }
        }
      }
      // 전략3: 퍼지 매칭
      if (!result.plateMatch) {
        let bestPlate = { entry: null, score: 0 }
        let bestHeat  = { entry: null, score: 0 }
        for (const e of allEntries) {
          const sp = stringSimilarity(ocr1, e.plateNo)
          if (sp > bestPlate.score) bestPlate = { entry: e, score: sp }
          const sh = stringSimilarity(ocr1, e.heatNo)
          if (sh > bestHeat.score) bestHeat = { entry: e, score: sh }
        }
        const best = bestPlate.score >= bestHeat.score ? bestPlate : bestHeat
        if (best.score >= 0.8) {
          result.plateMatch = { matched: true, entry: best.entry, confidence: 0.75 + best.score * 0.15, method: 'plate_fuzzy', fuzzyScore: best.score }
        }
      }
    }
  }

  // ─── Drawing 매칭 (unifiedDB allDrawings만 사용) ──────────────────────────
  if (allDrawings.length > 0 && ocr3) {
    // 전략1: drawingFull 완전 매칭 (e.g. 29308316-B01)
    const foundFull = allDrawings.find(e => e.drawingFull === ocr3)
    if (foundFull) {
      result.drawingMatch = { matched: true, entry: foundFull, confidence: 1.0, method: 'drawing_exact' }
    }

    // 전략1B: 8자리 base만 있는 경우 (TYPE B 스탬프: line1=29308308)
    if (!result.drawingMatch && /^\d{8}$/.test(ocr3)) {
      const byBase = allDrawings.filter(e => e.drawingBase === ocr3)
      if (byBase.length === 1) {
        result.drawingMatch = { matched: true, entry: byBase[0], confidence: 1.0, method: 'drawing_base_exact' }
      } else if (byBase.length > 1) {
        result.drawingMatch = { matched: true, entry: byBase[0], allByBase: byBase, confidence: 0.9, method: 'drawing_base_multi' }
      }
    }

    // 전략2: base+section 매칭 (full form OCR에서 skirtNo만 다른 경우)
    if (!result.drawingMatch) {
      const m = ocr3.match(/^(\d{8})-([A-Z])(\d{2})$/)
      if (m) {
        const byBase = allDrawings.find(e => e.drawingBase === m[1] && e.sectionCode === m[2])
        if (byBase) {
          result.drawingMatch = { matched: true, entry: byBase, confidence: 0.95, method: 'drawing_base_match' }
        }
      }
    }

    // 전략3: 퍼지 매칭
    if (!result.drawingMatch) {
      let best = { entry: null, score: 0 }
      for (const e of allDrawings) {
        const s = stringSimilarity(ocr3, e.drawingFull)
        if (s > best.score) best = { entry: e, score: s }
      }
      if (best.score >= 0.8) {
        result.drawingMatch = { matched: true, entry: best.entry, confidence: 0.70, method: 'drawing_fuzzy', fuzzyScore: best.score }
      }
    }
  }

  // ─── 통합 신뢰도 ─────────────────────────────────────────────────────────
  if (result.plateMatch?.matched && result.drawingMatch?.matched) {
    // Plate+Drawing 둘 다 매칭 — 평균
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

// ─── POST /api/db/plate/upload (Excel 업로드 — Python subprocess 파싱) ────────
app.post('/api/db/plate/upload', upload.array('files', 10), async (req, res) => {
  try {
    const uploadedFiles = req.files
    if (!uploadedFiles?.length) return res.status(400).json({ error: '파일이 없습니다' })

    const results = []
    const errors  = []

    for (const file of uploadedFiles) {
      const filename = file.originalname
      try {
        // 임시 파일 저장
        const tmpXlsx    = path.join(__dirname, `tmp_upload_${Date.now()}.xlsx`)
        const tmpEntries = path.join(__dirname, `tmp_entries_${Date.now()}.json`)
        const tmpMeta    = path.join(__dirname, `tmp_meta_${Date.now()}.json`)
        const fileId     = `${Date.now()}_${Math.random().toString(36).slice(2,7)}`

        fs.writeFileSync(tmpXlsx, file.buffer)

        // Python subprocess로 파싱
        const parseResult = await new Promise((resolve, reject) => {
          execFile('python3', [
            path.join(__dirname, 'parse_excel.py'),
            tmpXlsx, tmpEntries, tmpMeta, fileId, filename
          ], { timeout: 120000 }, (err, stdout, stderr) => {
            try { fs.unlinkSync(tmpXlsx) } catch(e) {}
            if (err) { reject(new Error(stderr || err.message)); return }
            try { resolve(JSON.parse(stdout.trim())) }
            catch(e) { reject(new Error('Python output parse error: ' + stdout.slice(0,200))) }
          })
        })

        if (!parseResult.ok) throw new Error(parseResult.error || '파싱 실패')

        // entries 로드
        const newEntries = JSON.parse(fs.readFileSync(tmpEntries, 'utf8'))
        try { fs.unlinkSync(tmpEntries) } catch(e) {}
        try { fs.unlinkSync(tmpMeta)    } catch(e) {}

        const { count: entryCount, alphaCount, numericCount, drawingCount, skipped } = parseResult

        // unifiedDB 메타 업데이트
        const existingIdx = unifiedDB.files.findIndex(f => f.filename === filename)
        const fileMeta = {
          fileId, filename, uploadedAt: new Date().toISOString(),
          count: entryCount, alphaCount, numericCount,
          drawingCount: drawingCount || 0, skipped, format: 'new'
        }

        if (existingIdx >= 0) {
          const oldId = unifiedDB.files[existingIdx].fileId
          unifiedEntries = unifiedEntries.filter(e => e._fileId !== oldId)
          unifiedDB.files[existingIdx] = fileMeta
          console.log(`[unifiedDB] Updated: ${filename} (${entryCount} entries)`)
        } else {
          unifiedDB.files.push(fileMeta)
          console.log(`[unifiedDB] Added: ${filename} (${entryCount} entries)`)
        }
        unifiedEntries.push(...newEntries)

        results.push({
          filename, count: entryCount, alphaCount, numericCount,
          drawingCount: drawingCount || 0, skipped, format: 'new', replaced: existingIdx >= 0
        })
      } catch(e) {
        console.error(`[upload] ${filename} error:`, e.message)
        errors.push({ filename, error: e.message })
      }
    }

    unifiedDB.updatedAt = new Date().toISOString()
    saveUnifiedDB()

    const totalEntries  = unifiedEntries.length
    const totalDrawings = getAllDrawingEntries().length
    res.json({ ok: true, uploaded: results, errors, totalFiles: unifiedDB.files.length, totalEntries, totalDrawings })
  } catch(e) {
    console.error('[upload] error:', e.message)
    res.status(400).json({ error: e.message })
  }
})


// ─── DELETE /api/db/plate/file/:fileId (개별 파일 삭제) ──────────────────────
app.delete('/api/db/plate/file/:fileId', (req, res) => {
  const { fileId } = req.params
  const idx = unifiedDB.files.findIndex(f => f.fileId === fileId)
  if (idx < 0) return res.status(404).json({ error: '파일을 찾을 수 없습니다' })
  const removed = unifiedDB.files.splice(idx, 1)[0]
  // entries에서 해당 파일 항목 제거
  unifiedEntries = unifiedEntries.filter(e => e._fileId !== fileId)
  unifiedDB.updatedAt = new Date().toISOString()
  saveUnifiedDB()
  console.log(`[unifiedDB] Removed file: ${removed.filename}`)
  res.json({ ok: true, removed: removed.filename, totalFiles: unifiedDB.files.length, totalEntries: unifiedEntries.length })
})

// ─── GET /api/db/plate/files (파일 목록 조회) ─────────────────────────────────
app.get('/api/db/plate/files', (req, res) => {
  const files = unifiedDB.files.map(f => ({
    fileId:       f.fileId,
    filename:     f.filename,
    uploadedAt:   f.uploadedAt,
    count:        f.count       || 0,  // meta에 저장된 count (entries 별도)
    alphaCount:   f.alphaCount  || 0,
    numericCount: f.numericCount || 0,
    drawingCount: f.drawingCount || 0,
    skipped:      f.skipped     || 0,
    format:       f.format      || 'new'
  }))
  res.json({ files, totalFiles: files.length, totalEntries: getAllPlateEntries().length, totalDrawings: getAllDrawingEntries().length })
})

// ─── POST /api/db/drawing/upload — 신규 통합 형식만 허용 ────────────────────
app.post('/api/db/drawing/upload', upload.single('file'), (req, res) => {
  // Drawing DB는 별도 업로드 불필요 — 통합 Excel에 포함됨
  return res.status(400).json({
    error: 'Drawing DB는 별도 업로드가 필요 없습니다. "DB 파일 업로드" 버튼으로 통합 Excel을 업로드해 주세요.'
  })
})

// ─── DELETE /api/db/plate (전체 초기화) ──────────────────────────────────────
app.delete('/api/db/plate', (req, res) => {
  unifiedDB = { files: [], updatedAt: null }
  unifiedEntries = []
  if (fs.existsSync(UNIFIED_DB_PATH))  try { fs.unlinkSync(UNIFIED_DB_PATH) }  catch(e) {}
  if (fs.existsSync(UNIFIED_ENT_PATH)) try { fs.unlinkSync(UNIFIED_ENT_PATH) } catch(e) {}
  plateDB = { files: [], updatedAt: null }
  if (fs.existsSync(PLATE_DB_PATH)) try { fs.unlinkSync(PLATE_DB_PATH) } catch(e) {}
  res.json({ ok: true })
})

// ─── DELETE /api/db/drawing ───────────────────────────────────────────────────
app.delete('/api/db/drawing', (req, res) => {
  // Drawing은 unified DB에 포함됨 — unified 전체 초기화로 처리
  if (fs.existsSync(DRAWING_DB_PATH)) try { fs.unlinkSync(DRAWING_DB_PATH) } catch(e) {}
  res.json({ ok: true, note: 'Drawing entries are part of unified DB. Use DELETE /api/db/plate to clear all.' })
})

// ─── GET /api/db/status ───────────────────────────────────────────────────────
app.get('/api/db/status', (req, res) => {
  const allPlates   = getAllPlateEntries()
  const allDrawings = getAllDrawingEntries()

  res.json({
    plate: {
      loaded:      allPlates.length > 0,
      count:       allPlates.length,
      fileCount:   unifiedDB.files.length,
      updatedAt:   unifiedDB.updatedAt,
      alphaCount:  allPlates.filter(e => e.type === 'alpha').length,
      numericCount:allPlates.filter(e => e.type === 'numeric').length,
      sample:      allPlates.slice(0, 3).map(e => e.plateNo)
    },
    drawing: {
      loaded:    allDrawings.length > 0,
      count:     allDrawings.length,
      updatedAt: unifiedDB.updatedAt,
      filename:  unifiedDB.files.map(f => f.filename).join(', ') || '',
      sample:    allDrawings.slice(0, 3).map(e => e.drawingFull)
    }
  })
})

// ─── POST /api/db/match (매칭 테스트) ────────────────────────────────────────
app.post('/api/db/match', (req, res) => {
  const { line1, line3 } = req.body
  const result = matchWithDBs(line1, line3)
  res.json(result)
})

// ─── POST /api/db/rematch (현재 DB로 일괄 재매칭) ─────────────────────────────
// 프론트에서 DB 변경 후 기존 OCR 결과들의 refMatch를 현재 DB 기준으로 재계산
// body: { items: [{ id, line1, line3 }] }
// response: { results: [{ id, refMatch }] }
app.post('/api/db/rematch', (req, res) => {
  const { items } = req.body
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items array required' })

  const results = items.map(({ id, line1, line3 }) => {
    const dbMatch = matchWithDBs(line1, line3)
    const { plateMatch, drawingMatch, combined } = dbMatch

    const refInfo = combined.matched ? {
      matched: true,
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
    } : { matched: false, confidence: 0, method: 'no_match', plate: null, drawing: null }

    // status 재계산
    const plateLoaded   = getAllPlateEntries().length > 0
    const drawingLoaded = getAllDrawingEntries().length > 0
    const anyDBLoaded = plateLoaded || drawingLoaded
    let newStatus = null
    if (anyDBLoaded) {
      if (!combined.matched) {
        newStatus = 'MANUAL'
      } else {
        const plateExact = !plateLoaded || (plateMatch?.matched && plateMatch.confidence >= 1.0)
        const drawingExact = !drawingLoaded || (drawingMatch?.matched && drawingMatch.confidence >= 1.0)
        newStatus = (plateExact && drawingExact) || combined.confidence >= 1.0 ? 'AUTO_OK' : 'REVIEW'
      }
    }

    return { id, refMatch: refInfo, newStatus }
  })

  res.json({ ok: true, results })
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
  // Long form: S355J0+N SSAB / S355J2+N SSAB
  const longForm = /S355J[02]\+N/.test(cleaned) && cleaned.includes('SSAB')
  // Short form: S355J0 / S355 J0 / S355JO (TYPE B — no SSAB)
  const shortForm = /S355\s?J[02O]/.test(cleaned)
  return { valid: longForm || shortForm, corrected: cleaned, form: longForm ? 'long' : shortForm ? 'short' : 'unknown' }
}
function validateDrawingNumber(val = '') {
  const cleaned = val.toUpperCase().replace(/\s/g, '')
  // Full form: 29308316-B01
  const fullValid = /^\d{8}-[BLMUWT](0[1-9]|1[01])$/.test(cleaned)
  // Base only (TYPE B line1): 29308308
  const baseValid = /^\d{8}$/.test(cleaned)
  return { valid: fullValid || baseValid, corrected: cleaned, baseOnly: baseValid && !fullValid }
}

/**
 * GPT가 반환한 layoutType 또는 줄 내용으로 타입 감지
 * TYPE A: line1=PlateNo, line2=Material, line3=DrawingNo
 * TYPE B: line1=DrawingBase(8자리), line2=PlateNo(numeric), line3=Material(short)
 */
function detectLayoutType(parsed) {
  // GPT가 명시적으로 알려준 경우 우선 사용
  if (parsed.layoutType === 'B') return 'B'
  if (parsed.layoutType === 'A') return 'A'

  const l1 = (parsed.line1 || '').trim().toUpperCase().replace(/\s/g, '')
  const l2 = (parsed.line2 || '').trim().toUpperCase().replace(/\s/g, '')
  const l3 = (parsed.line3 || '').trim().toUpperCase().replace(/\s/g, '')

  // TYPE B 감지: line1이 8자리 숫자 단독
  if (/^\d{8}$/.test(l1)) return 'B'
  // TYPE B 감지: line2가 숫자형 Plate No (7digits-...)
  if (/^\d{7}-/.test(l2) && /^\d{8}/.test(l1)) return 'B'
  // TYPE B 감지: line3가 재질 형태이고 line1이 드로잉처럼 생긴 경우
  if (/S355/.test(l3) && /^\d{8}/.test(l1) && !/[BLMUWT]\d{2}$/.test(l1)) return 'B'

  return 'A'
}

/**
 * 감지된 타입에 따라 줄 순서를 표준(Heat/Material/Drawing)으로 정규화
 * 반환: { plateNo, material, drawingNo, layoutType }
 */
function normalizeLines(parsed) {
  const layoutType = detectLayoutType(parsed)
  if (layoutType === 'B') {
    // TYPE B: line1=DrawingBase, line2=PlateNo, line3=Material
    return {
      plateNo: parsed.line2 || '',
      material: parsed.line3 || '',
      drawingNo: parsed.line1 || '',   // 8자리만 — drawing_base로 매칭
      layoutType: 'B'
    }
  }
  // TYPE A (기본): line1=PlateNo, line2=Material, line3=DrawingNo
  return {
    plateNo: parsed.line1 || '',
    material: parsed.line2 || '',
    drawingNo: parsed.line3 || '',
    layoutType: 'A'
  }
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
  // ─── 레이아웃 타입 감지 및 줄 정규화 ─────────────────────────────────────
  // TYPE A: line1=PlateNo, line2=Material, line3=DrawingNo  (기존 형태)
  // TYPE B: line1=DrawingBase, line2=PlateNo, line3=Material (새 형태)
  const norm = normalizeLines(parsed)
  const { layoutType } = norm

  const pv = validatePlateNumber(norm.plateNo)
  const mv = validateMaterial(norm.material)
  const dv = validateDrawingNumber(norm.drawingNo)

  let finalPlate = pv.corrected || norm.plateNo || ''
  let finalDrawing = dv.corrected || norm.drawingNo || ''
  let finalMaterial = mv.corrected || norm.material || ''
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
      finalPlate = plateMatch.entry.plateNo
    }
    if (drawingMatch?.matched && drawingMatch.entry?.drawingFull) {
      finalDrawing = drawingMatch.entry.drawingFull
    }
  }

  const pv2 = validatePlateNumber(finalPlate)
  const dv2 = validateDrawingNumber(finalDrawing)
  const validCount = [pv2.valid, mv.valid, dv2.valid].filter(Boolean).length

  // ─── OCR 판독 품질 (GPT confidence 제거 — 포맷 검증 기반) ───────────────
  // 문자 구조(개수/하이픈 위치)를 포맷 정규식으로 검증
  // good: 3개 모두 OK, partial: 1~2개 OK, poor: 모두 실패
  const ocrQuality = validCount === 3 ? 'good' : validCount >= 1 ? 'partial' : 'poor'

  // ─── Status 분류 (핵심 지표) ──────────────────────────────────────────────
  // AUTO_OK : 포맷 OK + 로드된 모든 DB에서 완전일치(100%) → 자동처리 가능
  // REVIEW  : 포맷 OK + DB 근사매칭 or 로드된 DB 일부만 매칭 → 사람이 확인 필요
  // MANUAL  : 포맷 OK + DB 없음 or DB에 없음 → 사람이 수동 입력
  // OCR_FAIL: 포맷 2개 이상 실패         → Agentic 재시도 or 수동
  let status
  // 실제 DB 로드 여부 = unified entries 수로 판단
  const plateLoaded   = getAllPlateEntries().length > 0
  const drawingLoaded = getAllDrawingEntries().length > 0
  const anyDBLoaded = plateLoaded || drawingLoaded

  if (validCount <= 1) {
    status = 'OCR_FAIL'
  } else if (!anyDBLoaded) {
    // DB 자체가 없음 → 포맷만 검증됨, DB 확인 불가 → MANUAL
    status = 'MANUAL'
  } else if (!dbMatch?.combined?.matched) {
    // DB는 있지만 매칭 실패 → 수동 입력 필요
    status = 'MANUAL'
  } else {
    // DB 매칭 있음
    const plateExact = !plateLoaded || (dbMatch.plateMatch?.matched && dbMatch.plateMatch.confidence >= 1.0)
    const drawingExact = !drawingLoaded || (dbMatch.drawingMatch?.matched && dbMatch.drawingMatch.confidence >= 1.0)
    if (plateExact && drawingExact) {
      status = 'AUTO_OK'  // 로드된 모든 DB에서 완전일치
    } else if (dbMatch.combined.confidence >= 1.0) {
      status = 'AUTO_OK'  // combined이 완전일치면 AUTO_OK
    } else {
      status = 'REVIEW'   // 근사 매칭이거나 일부만 매칭
    }
  }

  // ─── OCR 판독 품질 점수 (0~1, 포맷 기반) ─────────────────────────────────
  // 카드 Difficulty 대신 실질적인 판독 신뢰도로 사용
  const ocrScore = validCount / 3

  return {
    method, elapsed,
    line1: finalPlate,                 // 항상 Plate No (Heat No)
    line2: finalMaterial,              // 항상 재질 스펙
    line3: finalDrawing,               // 항상 Drawing No
    layoutType,                        // 'A' | 'B' — 원본 이미지 레이아웃 타입
    status,                            // 'AUTO_OK' | 'REVIEW' | 'MANUAL' | 'OCR_FAIL'
    ocrQuality,                        // 'good' | 'partial' | 'poor'
    ocrScore,                          // 0 | 0.33 | 0.67 | 1.0
    confidence: ocrScore,
    difficulty: validCount === 3 ? 1 : validCount === 2 ? 4 : validCount === 1 ? 7 : 10,
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

    // normalizeLines로 정규화 후 매칭
    const norm = normalizeLines(parsed)
    const dbMatch = matchWithDBs(norm.plateNo, norm.drawingNo)

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
      ? `Previous OCR pass (layoutType=${standardResult.layoutType||'A'}): Heat/Plate="${standardResult.line1}", Material="${standardResult.line2}", Drawing="${standardResult.line3}". These are already normalized. Verify and correct if needed.`
      : ''

    // Plate DB 후보군 삽입 (normalizeLines 기준으로 line1=PlateNo, line3=DrawingNo)
    let candidatesBlock = ''
    const allPlateEntriesAg = getAllPlateEntries()
    if (allPlateEntriesAg.length > 0 || getAllDrawingEntries().length > 0) {
      const lines = []

      // Drawing DB에서 매칭되는 도면번호 찾기 (line3 = Drawing, unifiedDB)
      const allDrawingsAg = getAllDrawingEntries()
      if (allDrawingsAg.length > 0 && standardResult?.line3) {
        const ocr3 = (standardResult.line3 || '').toUpperCase().replace(/\s/g, '')
        const drawMatch = allDrawingsAg.find(e => e.drawingFull === ocr3 || e.drawingBase === ocr3)
        if (drawMatch) {
          lines.push(`DRAWING DB MATCH: ${drawMatch.drawingFull} (Section: ${drawMatch.sectionCode}, Skirt: #${drawMatch.skirtNo})`)
          lines.push(`→ Drawing confirmed as: ${drawMatch.drawingFull}`)
        } else {
          const top3 = allDrawingsAg
            .map(e => ({ e, score: Math.max(stringSimilarity(ocr3, e.drawingFull), stringSimilarity(ocr3, e.drawingBase)) }))
            .sort((a,b) => b.score - a.score)
            .slice(0, 3)
          if (top3[0]?.score >= 0.6) {
            lines.push(`DRAWING DB CANDIDATES (top matches):`)
            top3.forEach(({ e, score }) => lines.push(`  ${e.drawingFull} (${(score*100).toFixed(0)}% match)`))
          }
        }
      }

      // Plate DB에서 유사한 Plate Number 후보 (line1 = PlateNo)
      if (allPlateEntriesAg.length > 0 && standardResult?.line1) {
        const ocr1 = (standardResult.line1 || '').toUpperCase().replace(/\s/g, '')
        const topPlates = allPlateEntriesAg
          .map(e => ({ e, score: Math.max(stringSimilarity(ocr1, e.plateNo), stringSimilarity(ocr1, e.heatNo)) }))
          .sort((a,b) => b.score - a.score)
          .slice(0, 8)
        if (topPlates.length > 0 && topPlates[0].score >= 0.5) {
          lines.push(`\nPLATE DB CANDIDATES for Plate/Heat Number (top matches):`)
          topPlates.forEach(({ e, score }) => lines.push(`  ${e.plateNo} (Heat: ${e.heatNo}, ${(score*100).toFixed(0)}% match)`))
          lines.push(`→ Plate/Heat Number should be one of the above.`)
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

    // normalizeLines로 정규화 후 매칭
    const norm = normalizeLines(parsed)
    const dbMatch = matchWithDBs(norm.plateNo, norm.drawingNo)

    res.json(buildResult(parsed, 'Agentic Vision (gpt-4o)', `${((Date.now()-t0)/1000).toFixed(1)}s`, dbMatch))
  } catch (e) {
    console.error('[agentic]', e.message)
    res.status(500).json({ error: e.message })
  }
})

app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')))

const PORT = process.env.PORT || 3000
app.listen(PORT, '0.0.0.0', () => console.log(`✅ Server running on http://0.0.0.0:${PORT}`))
