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

/** unifiedEntries 전체 반환 */
function getAllPlateEntries() { return unifiedEntries }

/** drawingFull 중복 제거 목록 반환 (unifiedEntries에서 도출) */
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

  // ── Standard: gpt-4o-mini  ─────────────────────────────────────────────────
  // 목적: 빠른 1차 판독. DB 후보군은 서버가 주입 ({{DB_HINTS}})
  standard: `You are an OCR specialist for dot-matrix steel plate stamps.

━━ LAYOUT TYPES ━━
TYPE A (common): Line1=PlateID  Line2=Material  Line3=Drawing
TYPE B (alt):    Line1=Drawing(8-digit only)  Line2=PlateID(numeric)  Line3=Material

━━ EXACT CHARACTER COUNT RULES — never deviate ━━
PlateID alpha:   [1][1][1][3]-[1][2]-[1][2]  = 6+hyphen+3+hyphen+3  e.g. B5L779-C12-A01
  • pos1: ONLY 'A' or 'B'  • pos2: single digit  • pos3: single UPPERCASE letter  • pos4-6: 3 digits
  • seg2: 1 letter + 2 digits  • seg3: 'A' or 'B' + 2 digits
PlateID numeric: [7]-[2]-[1]-[2]  e.g. 5606726-01-1-01
  • first segment MUST be exactly 7 digits
Drawing full:    [8]-[1][2]  e.g. 29308316-B01
  • 8 digits, hyphen, section letter [B L M U W T], 2-digit position [01-11]
Drawing base:    exactly 8 digits (TYPE B line1 only)
Material:        S355J0+N SSAB | S355J2+N SSAB | S355J0 | S355 J0
  ⚠ Material may be printed on TWO physical lines (e.g. "S355J0+N" on one line, "SSAB" below it).
     ALWAYS merge them into a single line2 value: "S355J0+N SSAB"
     NEVER put "SSAB" or any material fragment into line3 (Drawing field).

━━ DOT-MATRIX CONFUSION PAIRS ━━
Count connected strokes to determine character boundaries.
Each character = one connected dot cluster. Gap between clusters = character boundary.
  0 vs O  — digit-zero has consistent oval; letter-O identical → use position rule
  1 vs I  — use position rule (digits zone vs letter zone)
  5 vs S  — in digit context: read as 5; in alpha prefix (pos1-3 of alpha plate): read as S
  8 vs B  — 8 has TWO fully closed loops (top+bottom both rounded)
             B has flat vertical LEFT stroke + two half-loops on right
  8 vs 3  — 8: both loops fully closed on left AND right
             3: TOP stroke is nearly STRAIGHT/flat on the left, not fully closed
  B vs 6  — B starts with vertical stroke; 6 is fully curved
  A vs 4  — rarely confused but: A has peak+crossbar, 4 has open top

{{DB_HINTS}}

Return ONLY valid JSON — no markdown, no explanation:
{"line1":"...","line2":"...","line3":"...","layoutType":"A","confidence":0.0,"notes":"one-line quality note"}`,

  // ── Agentic: gpt-4o  ───────────────────────────────────────────────────────
  // 목적: Standard 결과를 받아 교정. 획 분석 심화. DB 후보군 독립 주입.
  agentic: `You are a precision OCR correction agent for industrial dot-matrix steel plate stamps.
{{HINT}}

━━ YOUR TASK ━━
Re-examine the image carefully and correct any OCR errors.
The previous pass may have misread characters — trust the IMAGE, not the previous text.

━━ LAYOUT TYPES ━━
TYPE A: Line1=PlateID  Line2=Material  Line3=Drawing(full: 8d-L2d)
TYPE B: Line1=Drawing BASE (8 digits ONLY, no hyphen)  Line2=PlateID(numeric)  Line3=Material(short)

━━ EXACT CHARACTER COUNT RULES ━━
Alpha PlateID  [1][1][1][3]-[1][2]-[1][2]:
  seg1 = 6 chars: pos1∈{A,B} · pos2=digit · pos3=letter · pos4-6=3digits
  seg2 = 3 chars: letter+2digits   seg3 = 3 chars: {A|B}+2digits
  Total chars (no hyphens) = 12
Numeric PlateID [7]-[2]-[1]-[2]:
  seg1 = exactly 7 digits. Total chars (no hyphens) = 12
Drawing full [8]-[L][2]:  8digits + hyphen + section{B,L,M,U,W,T} + 2digits(01-11)
Drawing base: exactly 8 digits (TYPE B only)
Material: S355J0+N SSAB | S355J2+N SSAB | S355J0 | S355 J0
  ⚠ CRITICAL: Material is sometimes stamped on TWO physical lines: "S355J0+N" then "SSAB" below.
     You MUST combine them → line2 = "S355J0+N SSAB". NEVER place "SSAB" into line3.

━━ STROKE-LEVEL DISAMBIGUATION (read pixel shapes, not assumptions) ━━
8 vs 3:
  • 8 → two FULLY CLOSED loops. Both left edges are curved/closed. The digit looks like two stacked circles.
  • 3 → top-left is OPEN (flat or concave leftward). Right side has two bumps. Left side has NO closed loop.
  → DECISION: Look at top-left corner. Closed curve = 8. Open/flat = 3. NEVER guess — look at pixels.

8 vs B:
  • 8 → no vertical left stroke. Symmetric top/bottom loops. Looks like two circles.
  • B → clear flat VERTICAL stroke on the LEFT side. Right side only has bumps/bumps.
  → DECISION: Is the left edge a straight vertical line? YES = B. NO (curved) = 8.

3 vs 8 vs B — SUMMARY:
  B: straight left stroke + two right bumps (in letter zone only)
  8: two closed loops, no straight lines anywhere
  3: right side two bumps, LEFT TOP is OPEN / straight

0 vs O:
  • In digit segments (numeric plate seg1, drawing 8-digit): treat as 0
  • In alpha plate seg1 pos3 (letter position): treat as O
  → Use positional rule strictly.

5 vs S:
  • In digit segments: 5
  • In alpha plate letter positions (seg1 pos3, seg2 pos1, seg3 pos1): S
  → Never read S in a pure-digit field.

1 vs I vs l:
  • In digit fields: always 1
  • In alpha plate letter position: always uppercase letter (I is valid)

6 vs G vs C:
  • 6 → fully enclosed bottom loop, top curves down-left
  • G → open C with inward horizontal tick on right
  • C → open on the right, no tick
  → DECISION: Does it have a bottom loop fully closed? 6. Has right tick? G. Otherwise C.

2 vs Z:
  • 2 → curved top, diagonal, bottom horizontal stroke
  • Z → top horizontal + diagonal + bottom horizontal (sharper angles)
  → In digit zones: 2. In letter zones: could be Z.

D vs 0 vs Q:
  • D → straight left vertical stroke + right curve (half oval)
  • 0 → fully symmetric oval, no flat edges
  • Q → oval with small tail/mark at bottom-right
  → D has flat left edge. 0 is pure oval. Q has distinguishing tail.

━━ VALIDATION BEFORE OUTPUT ━━
1. Count characters in each segment. If count doesn't match rules above → re-read that segment.
2. Check: alpha plate pos1 must be A or B. If you read 8/6/0/D → it is likely B or A.
3. Check: numeric plate seg1 must be exactly 7 digits (never 6, never 8).
4. Check: drawing seg1 must be exactly 8 digits. Section letter ∈ {B,L,M,U,W,T}.
5. If a DB candidate matches your reading with HIGH similarity (>80%) → double-check strokes before deviating.
6. Cross-check PlateID vs Drawing: they must come from same physical plate.
   ⭐ If DB hints show "CROSS-VALIDATED" candidate → that is almost certainly the correct answer.
   Use it EXACTLY as shown unless pixel-level evidence strongly contradicts it.

{{DB_HINTS}}

Return ONLY valid JSON — no markdown:
{"line1":"...","line2":"...","line3":"...","layoutType":"A","confidence":0.0,"notes":"what you corrected and why"}`
}

let runtimePrompts = { ...DEFAULT_PROMPTS }

// ─── Plate Number 파싱 유틸 ───────────────────────────────────────────────────
function extractHeatNumber(plateNo) {
  if (!plateNo) return null
  const p = plateNo.trim().toUpperCase()
  const matchA = p.match(/^([A-B]\d[A-Z]\d{3})-/)
  if (matchA) return matchA[1]
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

// ─── DB 후보군 블록 생성 (mini/pro 공용) ─────────────────────────────────────
/**
 * OCR 판독 결과(또는 raw 이미지)를 기반으로 DB 후보군 프롬프트 블록 생성
 * @param {string} rawPlate  - OCR이 읽은 PlateID (오독 포함 가능)
 * @param {string} rawDrawing - OCR이 읽은 Drawing (오독 포함 가능)
 * @param {object} opts
 *   opts.topN        - 반환할 후보 수 (기본 8)
 *   opts.threshold   - 최소 유사도 (기본 0.45)
 *   opts.label       - 블록 제목 (기본 'DB REFERENCE HINTS')
 */
function buildCandidatesBlock(rawPlate, rawDrawing, opts = {}) {
  const { topN = 8, threshold = 0.45, label = 'DB REFERENCE HINTS' } = opts

  const allEntries  = getAllPlateEntries()
  const allDrawings = getAllDrawingEntries()

  if (allEntries.length === 0 && allDrawings.length === 0) return ''

  const norm = s => (s || '').toUpperCase().replace(/\s/g, '')
  const ocr1 = norm(rawPlate)
  const ocr3 = norm(rawDrawing)

  const lines = [`\n━━ ${label} ━━`]

  // ── Plate 후보군 ────────────────────────────────────────────────────────
  if (allEntries.length > 0 && ocr1) {
    // plateNo 유사도 + heatNo 유사도 중 max, heatNo 일치 시 보너스
    const scored = allEntries.map(e => {
      const sp = stringSimilarity(ocr1, e.plateNo)
      const ocrHeat = extractHeatNumber(ocr1) || ocr1
      const sh = stringSimilarity(ocrHeat, e.heatNo) * 0.95  // heatNo는 짧아서 살짝 할인
      const score = Math.max(sp, sh)
      // 일치 문자 수 계산 (편집거리 기반)
      const matchedChars = e.plateNo.length - editDistance(ocr1, e.plateNo)
      return { e, score, matchedChars, totalChars: e.plateNo.length }
    })
    .filter(x => x.score >= threshold)
    .sort((a, b) => b.score !== a.score ? b.score - a.score : b.matchedChars - a.matchedChars)
    .slice(0, topN)

    if (scored.length > 0) {
      lines.push('Plate/Heat candidates (sorted by similarity):')
      for (const { e, score, matchedChars, totalChars } of scored) {
        const pct = Math.round(score * 100)
        const charInfo = `${matchedChars}/${totalChars} chars match`
        lines.push(`  ${e.plateNo}  (heat:${e.heatNo}  drawing:${e.drawingFull || '?'}  ${pct}% · ${charInfo})`)
      }
      lines.push('→ PlateID MUST exactly match one of the above formats.')
    }
  }

  // ── Drawing 후보군 ──────────────────────────────────────────────────────
  if (allDrawings.length > 0 && ocr3) {
    // 완전 일치 먼저
    const exactFull = allDrawings.find(e => e.drawingFull === ocr3)
    const exactBase = /^\d{8}$/.test(ocr3) ? allDrawings.find(e => e.drawingBase === ocr3) : null

    if (exactFull) {
      lines.push(`Drawing EXACT match: ${exactFull.drawingFull} ✓`)
    } else if (exactBase) {
      lines.push(`Drawing base match: ${exactBase.drawingFull} (base ${ocr3})`)
    } else {
      const drawScored = allDrawings
        .map(e => ({
          e,
          score: Math.max(
            stringSimilarity(ocr3, e.drawingFull),
            stringSimilarity(ocr3, e.drawingBase)
          )
        }))
        .filter(x => x.score >= 0.5)
        .sort((a, b) => b.score - a.score)
        .slice(0, 4)

      if (drawScored.length > 0) {
        lines.push('Drawing candidates:')
        drawScored.forEach(({ e, score }) =>
          lines.push(`  ${e.drawingFull}  (${Math.round(score * 100)}% match)`)
        )
      }
    }
  }

  // ── 교차검증 힌트 ───────────────────────────────────────────────────────
  // plate 후보와 drawing 후보가 같은 DB row를 가리키는지 확인
  if (ocr1 && allEntries.length > 0) {
    const ocrHeat = extractHeatNumber(ocr1) || ocr1

    if (ocr3) {
      // plate 후보 중 drawingFull이 ocr3과 일치하는 entry 찾기 (교차검증)
      const crossHit = allEntries.find(e => {
        const sp = stringSimilarity(ocr1, e.plateNo)
        const sh = stringSimilarity(ocrHeat, e.heatNo)
        return Math.max(sp, sh) >= threshold && e.drawingFull === ocr3
      })
      if (crossHit) {
        lines.push(`⭐ CROSS-VALIDATED: PlateID "${crossHit.plateNo}" AND Drawing "${crossHit.drawingFull}" point to SAME DB record.`)
        lines.push(`   → Use EXACTLY: PlateID="${crossHit.plateNo}"  Drawing="${crossHit.drawingFull}"`)
      }
    } else {
      // drawing이 없을 때: plate 후보의 drawingFull을 역으로 제시
      const topPlate = allEntries
        .map(e => {
          const sp = stringSimilarity(ocr1, e.plateNo)
          const sh = stringSimilarity(ocrHeat, e.heatNo)
          return { e, score: Math.max(sp, sh) }
        })
        .filter(x => x.score >= threshold)
        .sort((a, b) => b.score - a.score)[0]

      if (topPlate?.e?.drawingFull) {
        lines.push(`→ Expected drawing for top plate match: ${topPlate.e.drawingFull}`)
      }
    }
  }

  lines.push('NOTE: If your reading matches a candidate above, prefer that exact string.')
  return lines.join('\n')
}

// ─── 매칭 엔진 (unifiedDB 기반 + 교차검증) ───────────────────────────────────
/**
 * OCR 결과와 unifiedDB를 매칭
 * 교차검증: plateMatch.entry.drawingFull === drawingMatch.entry.drawingFull
 *   → 같은 row: confidence 보너스, crossValidated=true
 *   → 다른 row: confidence 패널티, status를 REVIEW로 강등
 */
function matchWithDBs(ocrLine1, ocrLine3) {
  const result = {
    plateMatch:    null,
    drawingMatch:  null,
    combined:      { matched: false, confidence: 0, method: 'no_match' },
    crossValidated: false
  }

  const normalize = s => (s || '').toUpperCase().replace(/\s/g, '')
  const ocr1 = normalize(ocrLine1)
  const ocr3 = normalize(ocrLine3)

  const allEntries  = getAllPlateEntries()
  const allDrawings = getAllDrawingEntries()

  // ─── Plate 매칭 ────────────────────────────────────────────────────────
  if (allEntries.length > 0 && ocr1) {
    // 전략1: plateNo 완전 매칭
    const found = allEntries.find(e => e.plateNo === ocr1)
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
      // 전략3: plateNo + heatNo 병렬 퍼지
      if (!result.plateMatch) {
        const ocrHeatFuzz = extractHeatNumber(ocr1) || ocr1
        let best = { entry: null, score: 0, byHeat: false }
        for (const e of allEntries) {
          const sp = stringSimilarity(ocr1, e.plateNo)
          const sh = stringSimilarity(ocrHeatFuzz, e.heatNo)
          const score = Math.max(sp, sh)
          if (score > best.score) best = { entry: e, score, byHeat: sh > sp }
        }
        if (best.score >= 0.75) {
          result.plateMatch = {
            matched: true, entry: best.entry,
            confidence: 0.70 + best.score * 0.20,
            method: best.byHeat ? 'heat_fuzzy' : 'plate_fuzzy',
            fuzzyScore: best.score
          }
        }
      }
    }
  }

  // ─── Drawing 매칭 ──────────────────────────────────────────────────────
  if (allDrawings.length > 0 && ocr3) {
    // 전략1: drawingFull 완전 매칭
    const foundFull = allDrawings.find(e => e.drawingFull === ocr3)
    if (foundFull) {
      result.drawingMatch = { matched: true, entry: foundFull, confidence: 1.0, method: 'drawing_exact' }
    }
    // 전략1B: 8자리 base only (TYPE B)
    if (!result.drawingMatch && /^\d{8}$/.test(ocr3)) {
      const byBase = allDrawings.filter(e => e.drawingBase === ocr3)
      if (byBase.length === 1) {
        result.drawingMatch = { matched: true, entry: byBase[0], confidence: 1.0, method: 'drawing_base_exact' }
      } else if (byBase.length > 1) {
        result.drawingMatch = { matched: true, entry: byBase[0], allByBase: byBase, confidence: 0.9, method: 'drawing_base_multi' }
      }
    }
    // 전략2: base+section 매칭
    if (!result.drawingMatch) {
      const m = ocr3.match(/^(\d{8})-([A-Z])(\d{2})$/)
      if (m) {
        const byBase = allDrawings.find(e => e.drawingBase === m[1] && e.sectionCode === m[2])
        if (byBase) {
          result.drawingMatch = { matched: true, entry: byBase, confidence: 0.95, method: 'drawing_base_match' }
        }
      }
    }
    // 전략3: 퍼지
    if (!result.drawingMatch) {
      let best = { entry: null, score: 0 }
      for (const e of allDrawings) {
        const s = stringSimilarity(ocr3, e.drawingFull)
        if (s > best.score) best = { entry: e, score: s }
      }
      if (best.score >= 0.8) {
        // fuzzy confidence: 점수 기반으로 계산 (0.80→0.82, 0.95→0.92 등)
        const fuzzyConf = 0.60 + best.score * 0.35
        result.drawingMatch = { matched: true, entry: best.entry, confidence: Math.min(0.97, fuzzyConf), method: 'drawing_fuzzy', fuzzyScore: best.score }
      }
    }
  }

  // ─── 교차검증 + 통합 신뢰도 ───────────────────────────────────────────
  if (result.plateMatch?.matched && result.drawingMatch?.matched) {
    const pEntry = result.plateMatch.entry
    const dEntry = result.drawingMatch.entry

    // 같은 row 여부: plate entry의 drawingFull이 drawing entry와 일치하는지
    const sameRow = pEntry?.drawingFull && dEntry?.drawingFull &&
                    pEntry.drawingFull === dEntry.drawingFull

    if (sameRow) {
      // 교차검증 성공 — plate_exact이면 drawing fuzzy여도 confidence 대폭 향상
      const pConf = result.plateMatch.confidence
      const dConf = result.drawingMatch.confidence
      let combinedConf
      if (pConf >= 1.0 && dConf >= 1.0) {
        combinedConf = 1.0   // 둘 다 exact → 완전일치
      } else if (pConf >= 1.0) {
        // plate exact + drawing fuzzy + 같은 row → plate가 전 세계 유일하므로 사실상 확정
        // drawing fuzzy는 OCR 오독 때문이지 DB 불일치가 아님 → confidence 높게
        combinedConf = Math.min(1.0, dConf + 0.20)
      } else {
        combinedConf = Math.min(1.0, Math.min(pConf, dConf) + 0.05)
      }
      result.combined = {
        matched: true,
        confidence: combinedConf,
        method: `${result.plateMatch.method}+${result.drawingMatch.method}`,
        crossValidated: true
      }
      result.crossValidated = true
    } else {
      // 교차검증 실패 — 두 매치가 다른 row를 가리킴 → 신뢰도 낮춤
      const avg = (result.plateMatch.confidence + result.drawingMatch.confidence) / 2
      result.combined = {
        matched: true,
        confidence: avg * 0.85,   // 15% 패널티
        method: `${result.plateMatch.method}+${result.drawingMatch.method}`,
        crossValidated: false,
        crossConflict: true        // REVIEW 강등 트리거
      }
    }
  } else if (result.plateMatch?.matched) {
    result.combined = { matched: true, confidence: result.plateMatch.confidence, method: result.plateMatch.method }
  } else if (result.drawingMatch?.matched) {
    result.combined = { matched: true, confidence: result.drawingMatch.confidence, method: result.drawingMatch.method }
  }

  return result
}

// ─── 두 문자열 유사도 (0~1) ──────────────────────────────────────────────────
function stringSimilarity(a, b) {
  if (!a || !b) return 0
  const longer  = a.length > b.length ? a : b
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

// ─── DELETE /api/db/plate (전체 초기화) ──────────────────────────────────────
app.delete('/api/db/plate', (req, res) => {
  unifiedDB = { files: [], updatedAt: null }
  unifiedEntries = []
  if (fs.existsSync(UNIFIED_DB_PATH))  try { fs.unlinkSync(UNIFIED_DB_PATH) }  catch(e) {}
  if (fs.existsSync(UNIFIED_ENT_PATH)) try { fs.unlinkSync(UNIFIED_ENT_PATH) } catch(e) {}
  if (fs.existsSync(PLATE_DB_PATH)) try { fs.unlinkSync(PLATE_DB_PATH) } catch(e) {}
  res.json({ ok: true })
})

// ─── GET /api/db/status ───────────────────────────────────────────────────────
app.get('/api/db/status', (req, res) => {
  const allPlates   = getAllPlateEntries()
  const allDrawings = getAllDrawingEntries()

  res.json({
    plate: {
      loaded:       allPlates.length > 0,
      count:        allPlates.length,
      fileCount:    unifiedDB.files.length,
      updatedAt:    unifiedDB.updatedAt,
      alphaCount:   allPlates.filter(e => e.type === 'alpha').length,
      numericCount: allPlates.filter(e => e.type === 'numeric').length,
      drawingCount: allDrawings.length,
      filename:     unifiedDB.files.map(f => f.filename).join(', ') || '',
      sample:       allPlates.slice(0, 3).map(e => e.plateNo)
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

    // status 재계산 (unified DB 단일 기준)
    const dbLoaded = getAllPlateEntries().length > 0
    let newStatus = null
    if (dbLoaded) {
      if (!combined.matched) {
        newStatus = 'MANUAL'
      } else {
        const plateExact = plateMatch?.matched && plateMatch.confidence >= 1.0
        const drawingExact = drawingMatch?.matched && drawingMatch.confidence >= 1.0
        const crossValidated = combined?.crossValidated === true
        if ((plateExact && drawingExact) || combined.confidence >= 1.0 || (plateExact && crossValidated)) {
          newStatus = 'AUTO_OK'
        } else {
          newStatus = 'REVIEW'
        }
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
  const l1 = (parsed.line1 || '').trim().toUpperCase().replace(/\s/g, '')
  const l2 = (parsed.line2 || '').trim().toUpperCase().replace(/\s/g, '')
  const l3 = (parsed.line3 || '').trim().toUpperCase().replace(/\s/g, '')

  // ── TYPE B의 엄격한 조건 ──────────────────────────────────────────────────
  // TYPE B: line1=Drawing(8자리), line2=숫자형PlateID, line3=Material(짧은형)
  // 세 조건을 모두 충족해야만 TYPE B로 인정
  const line1IsDrawingBase = /^\d{8}$/.test(l1)
  const line2IsNumericPlate = /^\d{7}-\d{2}-\d{1}-\d{2}$/.test(l2)
  const line3IsMaterial = /^S355/.test(l3)

  if (line1IsDrawingBase && line2IsNumericPlate) return 'B'
  if (line1IsDrawingBase && line3IsMaterial) return 'B'

  // ── AI 선언은 검증 후 신뢰 ───────────────────────────────────────────────
  // AI가 B라고 해도, line1이 실제 8자리 숫자가 아니면 무시
  if (parsed.layoutType === 'B') {
    // B 선언이 유효한지 확인: line1이 반드시 drawing base(8자리) 또는
    // line2가 숫자형 PlateID여야 함
    if (line1IsDrawingBase || line2IsNumericPlate) return 'B'
    // 조건 불만족 → AI 선언 무시하고 A로 처리
  }

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
  let material  = (parsed.line2 || '').trim()
  let drawingNo = (parsed.line3 || '').trim()

  // ── Material 흘림 감지: line3가 Material 파편인 경우 ────────────────────
  // 케이스: OCR이 "S355J0+N" / "SSAB" 처럼 쪼개서 SSAB가 line3에 들어온 경우
  // 또는 "S355J0+N SSAB" 전체가 line2에 들어왔지만 SSAB만 line3에 중복 존재
  const MATERIAL_FRAGMENTS = /^(SSAB|S355|J0|J2|\+N|J0\+N|J2\+N|S355J0|S355J2|S355\s?J[02])/i
  const DRAWING_PATTERN = /^\d{8}(-[A-Z]\d{2})?$|^[A-Z]{1,2}\d/  // 유효한 drawing 패턴

  if (drawingNo && MATERIAL_FRAGMENTS.test(drawingNo) && !DRAWING_PATTERN.test(drawingNo)) {
    // line3가 drawing이 아니라 material 파편 → line2에 합치고 line3 비우기
    const fragment = drawingNo.toUpperCase()
    const base = material.toUpperCase()
    // 이미 포함돼 있으면 중복 추가 안 함
    material  = base.includes(fragment) ? material : (material + ' ' + drawingNo).trim()
    drawingNo = ''
  }

  return {
    plateNo: parsed.line1 || '',
    material,
    drawingNo,
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

  // ─── Layout 오판 감지 ────────────────────────────────────────────────────
  // TYPE B로 분류됐지만 실제 내용이 유효하지 않으면 경고 추가
  let layoutWarning = ''
  if (layoutType === 'B' && !pv2.valid && !dv2.valid) {
    layoutWarning = '[Layout오판 가능] TYPE B로 분류됐으나 PlateID/Drawing 모두 무효 → TYPE A였을 수 있음'
  }

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
  const dbLoaded = getAllPlateEntries().length > 0

  if (validCount <= 1) {
    status = 'OCR_FAIL'
  } else if (!dbLoaded) {
    // DB 자체가 없음 → 포맷만 검증됨, DB 확인 불가 → MANUAL
    status = 'MANUAL'
  } else if (!dbMatch?.combined?.matched) {
    // DB는 있지만 매칭 실패 → 수동 입력 필요
    status = 'MANUAL'
  } else {
    // DB 매칭 있음
    const plateExact = dbMatch.plateMatch?.matched && dbMatch.plateMatch.confidence >= 1.0
    const drawingExact = dbMatch.drawingMatch?.matched && dbMatch.drawingMatch.confidence >= 1.0
    const crossValidated = dbMatch.combined?.crossValidated === true

    if (plateExact && drawingExact) {
      status = 'AUTO_OK'  // 둘 다 완전일치
    } else if (dbMatch.combined.confidence >= 1.0) {
      status = 'AUTO_OK'  // combined 완전일치
    } else if (plateExact && crossValidated) {
      // plate_exact + 교차검증 통과 → PlateID는 전 세계 유일 → 사실상 확정
      status = 'AUTO_OK'
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
    notes: [parsed.notes, layoutWarning].filter(Boolean).join(' | ') || '',
    refMatch: refInfo
  }
}

// ─── POST /api/ocr/standard ───────────────────────────────────────────────────
// 2-pass 구조: Pass1(DB 없이 초벌 판독) → DB 후보 생성 → Pass2(후보 포함 재판독)
// DB가 로드되지 않은 경우 Pass1 결과를 그대로 반환
app.post('/api/ocr/standard', async (req, res) => {
  const t0 = Date.now()
  try {
    const { imageBase64 } = req.body
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' })

    const allEntries = getAllPlateEntries()
    const hasDB = allEntries.length > 0

    // ── Pass 1: DB 힌트 없이 초벌 판독 ─────────────────────────────────
    const promptPass1 = runtimePrompts.standard.replace('{{DB_HINTS}}', '')
    const rawPass1    = await callVision(imageBase64, promptPass1, 'gpt-4o-mini')
    const parsedPass1 = parseOCR(rawPass1)
    const normPass1   = normalizeLines(parsedPass1)

    // DB가 없으면 Pass1 결과를 그대로 반환
    if (!hasDB) {
      const dbMatch = matchWithDBs(normPass1.plateNo, normPass1.drawingNo)
      const result  = buildResult(parsedPass1, 'Standard (gpt-4o-mini)', `${((Date.now()-t0)/1000).toFixed(1)}s`, dbMatch)
      result._dbHintsBlock = ''
      result._pass1 = null
      return res.json(result)
    }

    // ── DB 후보군 생성 (Pass1 결과 기반) ────────────────────────────────
    const dbHintsBlock = buildCandidatesBlock(normPass1.plateNo, normPass1.drawingNo, {
      topN: 8, threshold: 0.45, label: 'DB REFERENCE HINTS'
    })

    // DB 후보군이 있을 때만 Pass2 실행 (후보 없으면 Pass1 결과 사용)
    let finalParsed, finalNorm, passLabel
    if (dbHintsBlock.trim()) {
      // ── Pass 2: DB 후보 포함 프롬프트로 재판독 ──────────────────────
      const promptPass2 = runtimePrompts.standard.replace('{{DB_HINTS}}', dbHintsBlock)
      const rawPass2    = await callVision(imageBase64, promptPass2, 'gpt-4o-mini')
      finalParsed = parseOCR(rawPass2)
      finalNorm   = normalizeLines(finalParsed)
      passLabel   = 'Standard 2-pass (gpt-4o-mini)'
    } else {
      finalParsed = parsedPass1
      finalNorm   = normPass1
      passLabel   = 'Standard (gpt-4o-mini)'
    }

    const dbMatch = matchWithDBs(finalNorm.plateNo, finalNorm.drawingNo)
    const result  = buildResult(finalParsed, passLabel, `${((Date.now()-t0)/1000).toFixed(1)}s`, dbMatch)

    // agentic 단계에서 재사용할 정보 첨부
    result._dbHintsBlock = dbHintsBlock
    result._pass1 = {
      line1: parsedPass1.line1,
      line2: parsedPass1.line2,
      line3: parsedPass1.line3,
      layoutType: parsedPass1.layoutType
    }

    res.json(result)
  } catch (e) {
    console.error('[standard]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ─── POST /api/ocr/agentic ────────────────────────────────────────────────────
// standardResult._dbHintsBlock 재사용 또는 독립 생성
// standardResult 없어도 DB 후보군 독립 동작
app.post('/api/ocr/agentic', async (req, res) => {
  const t0 = Date.now()
  try {
    const { imageBase64, standardResult } = req.body
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' })

    // ── HINT 블록: Standard 결과 요약 (2-pass 정보 포함) ────────────────
    let hint = '(No previous OCR pass — reading from scratch)'
    if (standardResult) {
      const pass1Info = standardResult._pass1
        ? `  Pass1(raw):  PlateID="${standardResult._pass1.line1}"  Drawing="${standardResult._pass1.line3}"\n`
        : ''
      const dbStatus = standardResult.refMatch?.matched
        ? `MATCHED (conf=${(standardResult.refMatch.confidence*100).toFixed(0)}%, method=${standardResult.refMatch.method}${standardResult.refMatch.crossValidated ? ' ✓cross' : standardResult.refMatch.crossConflict ? ' ✗conflict' : ''})`
        : 'NOT MATCHED in DB'
      hint = `Previous OCR pass result (may contain errors):
  layoutType: ${standardResult.layoutType || 'A'}
  PlateID:    "${standardResult.line1}"
  Material:   "${standardResult.line2}"
  Drawing:    "${standardResult.line3}"
${pass1Info}  DB status:  ${dbStatus}
→ Re-examine the IMAGE. If DB shows a close candidate, prefer exact DB string over your reading.
→ Correct any misread characters based on stroke-level analysis.`
    }

    // ── DB 후보군: standardResult의 dbHintsBlock 재사용 or 독립 생성 ──────
    let dbHintsBlock = ''
    if (standardResult?._dbHintsBlock) {
      // Standard 2-pass가 이미 계산한 블록 재사용
      dbHintsBlock = standardResult._dbHintsBlock
    } else {
      // standardResult 없거나 _dbHintsBlock 없음 → OCR 라인 기반으로 독립 생성
      const rawPlate   = standardResult?.line1 || ''
      const rawDrawing = standardResult?.line3 || ''
      dbHintsBlock = buildCandidatesBlock(rawPlate, rawDrawing, {
        topN: 8, threshold: 0.45, label: 'DB REFERENCE HINTS'
      })
    }

    const prompt = runtimePrompts.agentic
      .replace('{{HINT}}',     hint)
      .replace('{{DB_HINTS}}', dbHintsBlock)

    const raw    = await callVision(imageBase64, prompt, 'gpt-4o')
    const parsed = parseOCR(raw)

    const norm    = normalizeLines(parsed)
    const dbMatch = matchWithDBs(norm.plateNo, norm.drawingNo)

    // 교차충돌 시 status 강제 REVIEW
    const result = buildResult(parsed, 'Agentic Vision (gpt-4o)', `${((Date.now()-t0)/1000).toFixed(1)}s`, dbMatch)
    if (dbMatch.combined?.crossConflict && result.status === 'AUTO_OK') {
      result.status = 'REVIEW'
    }

    res.json(result)
  } catch (e) {
    console.error('[agentic]', e.message)
    res.status(500).json({ error: e.message })
  }
})

app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')))

const PORT = process.env.PORT || 3000
app.listen(PORT, '0.0.0.0', () => console.log(`✅ Server running on http://0.0.0.0:${PORT}`))
