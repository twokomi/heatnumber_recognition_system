import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'

// ─── Cloudflare Bindings ───────────────────────────────────────────────────────
type Bindings = {
  DB: D1Database
  OPENAI_API_KEY: string
  OPENAI_BASE_URL: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors())

// ─── Static files ────────────────────────────────────────────────────────────
app.use('/static/*', serveStatic({ root: './public' }))

// ─── Mobile page ─────────────────────────────────────────────────────────────
app.get('/mobile', serveStatic({ path: './public/mobile.html' }))

// ─── 기본 프롬프트 ────────────────────────────────────────────────────────────
const DEFAULT_PROMPTS = {
  standard: `You are an OCR specialist for dot-matrix steel plate stamps.

━━ LAYOUT TYPES ━━
TYPE A (common): Line1=PlateID  Line2=Material  Line3=Drawing
TYPE B (alt):    Line1=Drawing(8-digit only)  Line2=PlateID(numeric)  Line3=Material

━━ EXACT CHARACTER COUNT RULES — never deviate ━━
PlateID alpha:   [1][1][1][3]-[1][2]-[1][2]  = 6+hyphen+3+hyphen+3  e.g. B5L779-C12-A01
  • pos1: ONLY 'A' or 'B'  • pos2: DIGIT ONLY (0–9, NEVER a letter)  • pos3: ANY single UPPERCASE letter (A–Z, including C, K, J…)  • pos4-6: 3 digits
  • seg2: 1 letter + 2 digits  • seg3: 'A' or 'B' + 2 digits
  ⚠ pos2 WARNING: pos2 is ALWAYS a digit. If it looks like G/D/O/Q → it is 6/0. NEVER output a letter in pos2.
  ⚠ pos3 WARNING: C, K, J are valid and exist in real plates. Do NOT default to A or B — read the image pixel shape.
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
  6 vs G  — 6: fully enclosed bottom loop, top curls inward → it is a DIGIT
             G: open arc with inward horizontal tick on right → it is a LETTER
             ⚠ In pos2 (digit zone): ALWAYS read as 6, NEVER G.
  B vs C  — B has vertical LEFT stroke + two closed right bumps (right side is CLOSED)
             C has NO vertical left stroke; it is an open arc, right side is OPEN/missing
             → If the right side is open (gap visible), it is C. If right side is closed bumps, it is B.
  A vs 4  — rarely confused but: A has peak+crossbar, 4 has open top

{{DB_HINTS}}

Return ONLY valid JSON — no markdown, no explanation:
{"line1":"...","line2":"...","line3":"...","layoutType":"A","confidence":0.0,"notes":"one-line quality note"}`,

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
  seg1 = 6 chars: pos1∈{A,B} · pos2=DIGIT ONLY (G→6, D→0, Q→0) · pos3=ANY letter (A–Z, C/K/J are valid) · pos4-6=3digits
  ⚠ pos2: ALWAYS a digit. G/D/Q in pos2 position = misread → correct to 6/0/0.
  ⚠ pos3: Do NOT bias toward A/B/L just because they are common. Read pixel shapes only.
  seg2 = 3 chars: letter+2digits   seg3 = 3 chars: {A|B}+2digits
  Total chars (no hyphens) = 12
Numeric PlateID [7]-[2]-[1]-[2]:
  seg1 = exactly 7 digits. Total chars (no hyphens) = 12
Drawing full [8]-[L][2]:  8digits + hyphen + section{B,L,M,U,W,T} + 2digits(01-11)
Drawing base: exactly 8 digits (TYPE B only)
Material: S355J0+N SSAB | S355J2+N SSAB | S355J0 | S355 J0
  ⚠ CRITICAL: Material is sometimes stamped on TWO physical lines: "S355J0+N" then "SSAB" below.
     You MUST combine them → line2 = "S355J0+N SSAB". NEVER place "SSAB" into line3.

━━ STROKE-LEVEL DISAMBIGUATION ━━
8 vs 3:
  • 8 → two FULLY CLOSED loops. Both left edges are curved/closed.
  • 3 → top-left is OPEN (flat or concave leftward). Right side has two bumps.
8 vs B:
  • 8 → no vertical left stroke. Symmetric top/bottom loops.
  • B → clear flat VERTICAL stroke on the LEFT side.
B vs C (critical for pos3):
  • B → VERTICAL stroke on LEFT + two closed bumps on RIGHT
  • C → NO vertical left stroke; open arc; RIGHT SIDE IS OPEN
6 vs G: 6 has fully enclosed bottom loop; G has open arc with right tick
0 vs O: use position rule (digit zone vs letter zone)

━━ VALIDATION BEFORE OUTPUT ━━
1. Count characters in each segment.
2. alpha plate pos1 must be A or B. pos2 must be DIGIT.
3. numeric plate seg1 must be exactly 7 digits.
4. drawing seg1 must be exactly 8 digits. Section letter ∈ {B,L,M,U,W,T}.
5. If DB candidate matches >80% similarity → double-check strokes before deviating.
6. pos3 can be ANY letter — trust pixel reading over DB frequency.
7. NEVER copy DB candidate if image reading differs significantly.

{{DB_HINTS}}

Return ONLY valid JSON — no markdown:
{"line1":"...","line2":"...","line3":"...","layoutType":"A","confidence":0.0,"notes":"what you corrected and why"}`
}

// runtime prompt store (KV가 없으므로 메모리에 유지)
let runtimePrompts = { ...DEFAULT_PROMPTS }

// ─── DB 유틸 (D1) ─────────────────────────────────────────────────────────────
type PlateEntry = {
  plateNo: string
  heatNo: string
  type: 'alpha' | 'numeric'
  drawingFull: string
  drawingBase: string
  sectionCode: string
  skirtNo: number
}

async function getAllPlateEntries(db: D1Database): Promise<PlateEntry[]> {
  const result = await db.prepare('SELECT plateNo, heatNo, type, drawingFull, drawingBase, sectionCode, skirtNo FROM plates').all<PlateEntry>()
  return result.results || []
}

async function getAllDrawingEntries(db: D1Database) {
  const result = await db.prepare('SELECT DISTINCT drawingFull, drawingBase, sectionCode, skirtNo FROM plates WHERE drawingFull IS NOT NULL').all<{ drawingFull: string, drawingBase: string, sectionCode: string, skirtNo: number }>()
  return result.results || []
}

// ─── 문자열 유사도 ─────────────────────────────────────────────────────────────
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)])
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1])
  return dp[m][n]
}

function stringSimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const maxLen = Math.max(a.length, b.length)
  return maxLen === 0 ? 1 : (maxLen - editDistance(a, b)) / maxLen
}

// ─── 유틸 함수 ────────────────────────────────────────────────────────────────
function extractHeatNumber(plateNo: string): string | null {
  if (!plateNo) return null
  const p = plateNo.trim().toUpperCase()
  const matchA = p.match(/^([A-B]\d[A-Z]\d{3})-/)
  if (matchA) return matchA[1]
  const matchB = p.match(/^(\d{7})-/)
  if (matchB) return matchB[1]
  return null
}

function validatePlateNumber(val = '') {
  const cleaned = val.toUpperCase().replace(/\s/g, '')
  const validA = /^[AB]\d[A-Z]\d{3}-[A-Z]\d{2}-[AB]\d{2}$/.test(cleaned)
  const validB = /^\d{7}-\d{2}-\d{1}-\d{2}$/.test(cleaned)
  return { valid: validA || validB, corrected: cleaned, format: validA ? 'alpha' : validB ? 'numeric' : 'unknown' }
}

function validateMaterial(val = '') {
  const cleaned = val.toUpperCase().replace(/\s+/g, ' ').trim()
  const longForm = /S355J[02]\+N/.test(cleaned) && cleaned.includes('SSAB')
  const shortForm = /S355\s?J[02O]/.test(cleaned)
  return { valid: longForm || shortForm, corrected: cleaned, form: longForm ? 'long' : shortForm ? 'short' : 'unknown' }
}

function validateDrawingNumber(val = '') {
  const cleaned = val.toUpperCase().replace(/\s/g, '')
  const fullValid = /^\d{8}-[BLMUWT](0[1-9]|1[01])$/.test(cleaned)
  const baseValid = /^\d{8}$/.test(cleaned)
  return { valid: fullValid || baseValid, corrected: cleaned, baseOnly: baseValid && !fullValid }
}

function detectLayoutType(parsed: any): 'A' | 'B' {
  const l1 = (parsed.line1 || '').trim().toUpperCase().replace(/\s/g, '')
  const l2 = (parsed.line2 || '').trim().toUpperCase().replace(/\s/g, '')
  const l3 = (parsed.line3 || '').trim().toUpperCase().replace(/\s/g, '')
  const line1IsDrawingBase = /^\d{8}$/.test(l1)
  const line2IsNumericPlate = /^\d{7}-\d{2}-\d{1}-\d{2}$/.test(l2)
  const line3IsMaterial = /^S355/.test(l3)
  if (line1IsDrawingBase && line2IsNumericPlate) return 'B'
  if (line1IsDrawingBase && line3IsMaterial) return 'B'
  if (parsed.layoutType === 'B' && (line1IsDrawingBase || line2IsNumericPlate)) return 'B'
  return 'A'
}

function normalizeLines(parsed: any) {
  const layoutType = detectLayoutType(parsed)
  if (layoutType === 'B') {
    return { plateNo: parsed.line2 || '', material: parsed.line3 || '', drawingNo: parsed.line1 || '', layoutType: 'B' as const }
  }
  let material = (parsed.line2 || '').trim()
  let drawingNo = (parsed.line3 || '').trim()
  const MATERIAL_FRAGMENTS = /^(SSAB|S355|J0|J2|\+N|J0\+N|J2\+N|S355J0|S355J2|S355\s?J[02])/i
  const DRAWING_PATTERN = /^\d{8}(-[A-Z]\d{2})?$|^[A-Z]{1,2}\d/
  if (drawingNo && MATERIAL_FRAGMENTS.test(drawingNo) && !DRAWING_PATTERN.test(drawingNo)) {
    const fragment = drawingNo.toUpperCase()
    const base = material.toUpperCase()
    material = base.includes(fragment) ? material : (material + ' ' + drawingNo).trim()
    drawingNo = ''
  }
  return { plateNo: parsed.line1 || '', material, drawingNo, layoutType: 'A' as const }
}

function parseOCR(raw: string) {
  try {
    const m = raw.match(/\{[\s\S]*\}/)
    return JSON.parse(m ? m[0] : raw)
  } catch {
    return { line1: '', line2: '', line3: '', confidence: 0, notes: raw.slice(0, 200) }
  }
}

// ─── DB 매칭 엔진 ──────────────────────────────────────────────────────────────
async function matchWithDBs(db: D1Database, ocrLine1: string, ocrLine3: string) {
  const result: any = {
    plateMatch: null,
    drawingMatch: null,
    combined: { matched: false, confidence: 0, method: 'no_match' },
    crossValidated: false
  }

  const normalize = (s: string) => (s || '').toUpperCase().replace(/\s/g, '')
  const ocr1 = normalize(ocrLine1)
  const ocr3 = normalize(ocrLine3)

  const allEntries = await getAllPlateEntries(db)
  const allDrawings = await getAllDrawingEntries(db)

  // ─── Plate 매칭 ─────────────────────────────────────────────────────
  if (allEntries.length > 0 && ocr1) {
    const found = allEntries.find(e => e.plateNo === ocr1)
    if (found) {
      result.plateMatch = { matched: true, entry: found, confidence: 1.0, method: 'plate_exact' }
    } else {
      const ocrHeat = extractHeatNumber(ocrLine1)?.toUpperCase()
      if (ocrHeat) {
        const byHeat = allEntries.filter(e => e.heatNo === ocrHeat)
        if (byHeat.length > 0) {
          result.plateMatch = { matched: true, entry: byHeat[0], allByHeat: byHeat, confidence: 0.95, method: 'heat_exact' }
        }
      }
      if (!result.plateMatch) {
        const ocrHeatFuzz = extractHeatNumber(ocr1) || ocr1
        let best: any = { entry: null, score: 0, byHeat: false }
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

  // ─── Drawing 매칭 ────────────────────────────────────────────────────
  if (allDrawings.length > 0 && ocr3) {
    const foundFull = allDrawings.find(e => e.drawingFull === ocr3)
    if (foundFull) {
      result.drawingMatch = { matched: true, entry: foundFull, confidence: 1.0, method: 'drawing_exact' }
    }
    if (!result.drawingMatch && /^\d{8}$/.test(ocr3)) {
      const byBase = allDrawings.filter(e => e.drawingBase === ocr3)
      if (byBase.length === 1) {
        result.drawingMatch = { matched: true, entry: byBase[0], confidence: 1.0, method: 'drawing_base_exact' }
      } else if (byBase.length > 1) {
        result.drawingMatch = { matched: true, entry: byBase[0], allByBase: byBase, confidence: 0.9, method: 'drawing_base_multi' }
      }
    }
    if (!result.drawingMatch) {
      const m = ocr3.match(/^(\d{8})-([A-Z])(\d{2})$/)
      if (m) {
        const byBase = allDrawings.find(e => e.drawingBase === m[1] && e.sectionCode === m[2])
        if (byBase) {
          result.drawingMatch = { matched: true, entry: byBase, confidence: 0.95, method: 'drawing_base_match' }
        }
      }
    }
    if (!result.drawingMatch) {
      let best: any = { entry: null, score: 0 }
      for (const e of allDrawings) {
        const s = stringSimilarity(ocr3, e.drawingFull)
        if (s > best.score) best = { entry: e, score: s }
      }
      if (best.score >= 0.8) {
        const fuzzyConf = 0.60 + best.score * 0.35
        result.drawingMatch = { matched: true, entry: best.entry, confidence: Math.min(0.97, fuzzyConf), method: 'drawing_fuzzy', fuzzyScore: best.score }
      }
    }
  }

  // ─── 교차검증 + 통합 신뢰도 ──────────────────────────────────────────
  if (result.plateMatch?.matched && result.drawingMatch?.matched) {
    const pEntry = result.plateMatch.entry
    const dEntry = result.drawingMatch.entry
    const sameRow = pEntry?.drawingFull && dEntry?.drawingFull && pEntry.drawingFull === dEntry.drawingFull

    if (sameRow) {
      const pConf = result.plateMatch.confidence
      const dConf = result.drawingMatch.confidence
      let combinedConf: number
      if (pConf >= 1.0 && dConf >= 1.0) {
        combinedConf = 1.0
      } else if (pConf >= 1.0) {
        combinedConf = Math.min(1.0, (pConf + dConf) / 2 + 0.20)
      } else {
        combinedConf = (pConf + dConf) / 2 + 0.05
      }
      result.combined = { matched: true, confidence: Math.min(1.0, combinedConf), method: `${result.plateMatch.method}+${result.drawingMatch.method}`, crossValidated: true }
      result.crossValidated = true
    } else {
      const avgConf = (result.plateMatch.confidence + result.drawingMatch.confidence) / 2
      const combinedConf = avgConf * 0.85
      result.combined = { matched: true, confidence: combinedConf, method: `${result.plateMatch.method}+${result.drawingMatch.method}`, crossConflict: true }

      // ─── crossConflict 재검토: plate_exact이면 drawing OCR을 재비교 ──────
      if (result.plateMatch.confidence >= 1.0 && pEntry?.drawingFull) {
        const dbDrawing = normalize(pEntry.drawingFull)
        const sim = stringSimilarity(ocr3, dbDrawing)
        console.log(`[crossConflict재검토] ocr3="${ocr3}" dbDrawing="${dbDrawing}" sim=${sim.toFixed(3)} pass=${sim >= 0.85}`)
        if (sim >= 0.85) {
          const correctedEntry = { ...pEntry, drawingFull: pEntry.drawingFull, drawingBase: pEntry.drawingBase, sectionCode: pEntry.sectionCode, skirtNo: pEntry.skirtNo }
          result.drawingMatch = {
            matched: true, entry: correctedEntry, confidence: 1.0, method: 'drawing_from_plate_exact',
            correctedFrom: ocrLine3
          }
          result.combined = {
            matched: true, confidence: 1.0,
            method: 'plate_exact+drawing_from_plate_exact',
            crossValidated: true, drawingCorrected: true,
            originalOcrDrawing: ocrLine3
          }
          result.crossValidated = true
        }
      }
    }
  } else if (result.plateMatch?.matched) {
    const pConf = result.plateMatch.confidence
    result.combined = { matched: true, confidence: pConf * 0.85, method: result.plateMatch.method }

    // plate_exact이면 drawing 역조회
    if (pConf >= 1.0 && result.plateMatch.entry?.drawingFull) {
      const dbDrawing = normalize(result.plateMatch.entry.drawingFull)
      if (ocr3 && stringSimilarity(ocr3, dbDrawing) >= 0.85) {
        const correctedEntry = result.plateMatch.entry
        result.drawingMatch = {
          matched: true, entry: correctedEntry, confidence: 1.0, method: 'drawing_from_plate_exact',
          correctedFrom: ocrLine3
        }
        result.combined = {
          matched: true, confidence: 1.0,
          method: 'plate_exact+drawing_from_plate_exact',
          crossValidated: true, drawingCorrected: true,
          originalOcrDrawing: ocrLine3
        }
        result.crossValidated = true
      } else if (!ocr3) {
        result.drawingMatch = {
          matched: true, entry: result.plateMatch.entry, confidence: 0.9, method: 'drawing_from_plate_exact'
        }
        result.combined = { matched: true, confidence: 0.9, method: 'plate_exact+drawing_from_plate_exact', crossValidated: true }
        result.crossValidated = true
      }
    }
  } else if (result.drawingMatch?.matched) {
    result.combined = { matched: true, confidence: result.drawingMatch.confidence * 0.80, method: result.drawingMatch.method }
  }

  return result
}

// ─── DB 후보군 블록 생성 ──────────────────────────────────────────────────────
async function buildCandidatesBlock(db: D1Database, rawPlate: string, rawDrawing: string, opts: any = {}) {
  const { topN = 8, threshold = 0.45, label = 'DB REFERENCE HINTS' } = opts
  const allEntries = await getAllPlateEntries(db)
  const allDrawings = await getAllDrawingEntries(db)
  if (allEntries.length === 0 && allDrawings.length === 0) return ''

  const norm = (s: string) => (s || '').toUpperCase().replace(/\s/g, '')
  const ocr1 = norm(rawPlate)
  const ocr3 = norm(rawDrawing)
  const lines: string[] = [`\n━━ ${label} ━━`]

  if (allEntries.length > 0 && ocr1) {
    const scored = allEntries.map(e => {
      const sp = stringSimilarity(ocr1, e.plateNo)
      const ocrHeat = extractHeatNumber(ocr1) || ocr1
      const sh = stringSimilarity(ocrHeat, e.heatNo) * 0.95
      const score = Math.max(sp, sh)
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
        lines.push(`  ${e.plateNo}  (heat:${e.heatNo}  drawing:${e.drawingFull || '?'}  ${pct}% · ${matchedChars}/${totalChars} chars match)`)
      }
      lines.push('→ PlateID MUST exactly match one of the above formats.')
    }
  }

  if (allDrawings.length > 0 && ocr3) {
    const exactFull = allDrawings.find(e => e.drawingFull === ocr3)
    const exactBase = /^\d{8}$/.test(ocr3) ? allDrawings.find(e => e.drawingBase === ocr3) : null
    if (exactFull) {
      lines.push(`Drawing EXACT match: ${exactFull.drawingFull} ✓`)
    } else if (exactBase) {
      lines.push(`Drawing base match: ${exactBase.drawingFull} (base ${ocr3})`)
    } else {
      const drawScored = allDrawings
        .map(e => ({ e, score: Math.max(stringSimilarity(ocr3, e.drawingFull), stringSimilarity(ocr3, e.drawingBase)) }))
        .filter(x => x.score >= 0.5)
        .sort((a, b) => b.score - a.score)
        .slice(0, 4)
      if (drawScored.length > 0) {
        lines.push('Drawing candidates:')
        drawScored.forEach(({ e, score }) => lines.push(`  ${e.drawingFull}  (${Math.round(score * 100)}% match)`))
      }
    }
  }

  if (ocr1 && allEntries.length > 0 && ocr3) {
    const ocrHeat = extractHeatNumber(ocr1) || ocr1
    const crossHit = allEntries.find(e => {
      const sp = stringSimilarity(ocr1, e.plateNo)
      const sh = stringSimilarity(ocrHeat, e.heatNo)
      return Math.max(sp, sh) >= threshold && e.drawingFull === ocr3
    })
    if (crossHit) {
      lines.push(`⭐ CROSS-VALIDATED: PlateID "${crossHit.plateNo}" AND Drawing "${crossHit.drawingFull}" exist together in DB.`)
      lines.push(`   → If your image reading closely matches these, they are likely correct.`)
      lines.push(`   → But READ THE IMAGE FIRST — only use this if your pixel-level reading agrees.`)
    }
  }

  lines.push('NOTE: DB candidates are for REFERENCE only. Always read the image first.')
  return lines.join('\n')
}

// ─── OpenAI Vision 호출 ───────────────────────────────────────────────────────
async function callVision(imageBase64: string, prompt: string, model: string, env: Bindings) {
  const apiKey = env.OPENAI_API_KEY
  const baseURL = env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
  if (!apiKey) throw new Error('API Key가 설정되지 않았습니다. 설정 버튼을 클릭해 주세요.')
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
  const data: any = await response.json()
  return data.choices?.[0]?.message?.content || '{}'
}

// ─── buildResult ──────────────────────────────────────────────────────────────
async function buildResult(parsed: any, method: string, elapsed: string, dbMatch: any, db: D1Database) {
  const norm = normalizeLines(parsed)
  const { layoutType } = norm

  const pv = validatePlateNumber(norm.plateNo)
  const mv = validateMaterial(norm.material)
  const dv = validateDrawingNumber(norm.drawingNo)

  let finalPlate = pv.corrected || norm.plateNo || ''
  let finalDrawing = dv.corrected || norm.drawingNo || ''
  let finalMaterial = mv.corrected || norm.material || ''
  let refInfo: any = null

  const allPlates = await getAllPlateEntries(db)
  const dbLoaded = allPlates.length > 0

  if (dbMatch) {
    const { plateMatch, drawingMatch, combined } = dbMatch
    refInfo = {
      matched: combined.matched,
      confidence: combined.confidence,
      method: combined.method,
      crossValidated: combined.crossValidated || false,
      drawingCorrected: combined.drawingCorrected || false,
      originalOcrDrawing: combined.originalOcrDrawing || null,
      crossConflict: combined.crossConflict || false,
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
        matchMethod: drawingMatch.method,
        correctedFrom: drawingMatch.correctedFrom || null
      } : null
    }

    if (plateMatch?.matched && plateMatch.confidence >= 1.0 && plateMatch.entry?.plateNo) {
      finalPlate = plateMatch.entry.plateNo
    }
    if (drawingMatch?.matched && drawingMatch.confidence >= 1.0 && drawingMatch.entry?.drawingFull) {
      finalDrawing = drawingMatch.entry.drawingFull
    }
  }

  const pv2 = validatePlateNumber(finalPlate)
  const dv2 = validateDrawingNumber(finalDrawing)
  const validCount = [pv2.valid, mv.valid, dv2.valid].filter(Boolean).length

  let layoutWarning = ''
  if (layoutType === 'B' && !pv2.valid && !dv2.valid) {
    layoutWarning = '[Layout오판 가능] TYPE B로 분류됐으나 PlateID/Drawing 모두 무효 → TYPE A였을 수 있음'
  }

  const ocrQuality = validCount === 3 ? 'good' : validCount >= 1 ? 'partial' : 'poor'

  let status: string
  if (validCount <= 1) {
    status = 'OCR_FAIL'
  } else if (!dbLoaded) {
    status = 'MANUAL'
  } else if (!dbMatch?.combined?.matched) {
    status = 'MANUAL'
  } else {
    const plateExact = dbMatch.plateMatch?.matched && dbMatch.plateMatch.confidence >= 1.0
    const drawingExact = dbMatch.drawingMatch?.matched && dbMatch.drawingMatch.confidence >= 1.0
    const crossValidated = dbMatch.combined?.crossValidated === true
    if (plateExact && drawingExact) {
      status = 'AUTO_OK'
    } else if (dbMatch.combined.confidence >= 1.0) {
      status = 'AUTO_OK'
    } else if (plateExact && crossValidated) {
      status = 'AUTO_OK'
    } else {
      status = 'REVIEW'
    }
  }

  const ocrScore = validCount / 3
  return {
    method, elapsed,
    line1: finalPlate,
    line2: finalMaterial,
    line3: finalDrawing,
    layoutType,
    status,
    ocrQuality,
    ocrScore,
    confidence: ocrScore,
    difficulty: validCount === 3 ? 1 : validCount === 2 ? 4 : validCount === 1 ? 7 : 10,
    validation: { heat: pv2.valid, material: mv.valid, drawing: dv2.valid },
    notes: [parsed.notes, layoutWarning].filter(Boolean).join(' | ') || '',
    refMatch: refInfo
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── API Routes ───────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

// ── POST /api/config ─────────────────────────────────────────────────────────
// Workers에서는 API key를 secrets로만 관리. runtime 저장 불가.
app.post('/api/config', async (c) => {
  // Workers에서는 env secrets 사용 — UI에서 직접 설정 불가
  return c.json({ ok: false, error: 'Workers 환경에서는 Cloudflare Secrets(OPENAI_API_KEY)로 설정하세요.' }, 400)
})

// ── GET /api/config/status ────────────────────────────────────────────────────
app.get('/api/config/status', async (c) => {
  const apiKey = c.env.OPENAI_API_KEY
  return c.json({
    configured: !!apiKey,
    keyPreview: apiKey ? apiKey.slice(0, 4) + '...' + apiKey.slice(-4) : '',
    persisted: !!apiKey
  })
})

// ── GET /api/prompts ──────────────────────────────────────────────────────────
app.get('/api/prompts', (c) => {
  return c.json({ standard: runtimePrompts.standard, agentic: runtimePrompts.agentic, defaults: DEFAULT_PROMPTS })
})

// ── POST /api/prompts ─────────────────────────────────────────────────────────
app.post('/api/prompts', async (c) => {
  const { type, prompt } = await c.req.json()
  if (!type || !['standard', 'agentic'].includes(type)) return c.json({ error: 'type must be "standard" or "agentic"' }, 400)
  if (!prompt || prompt.trim().length < 10) return c.json({ error: 'prompt too short' }, 400)
  runtimePrompts[type as 'standard' | 'agentic'] = prompt.trim()
  return c.json({ ok: true, type, length: prompt.length })
})

// ── POST /api/prompts/reset ───────────────────────────────────────────────────
app.post('/api/prompts/reset', async (c) => {
  const { type } = await c.req.json()
  if (type === 'standard') runtimePrompts.standard = DEFAULT_PROMPTS.standard
  else if (type === 'agentic') runtimePrompts.agentic = DEFAULT_PROMPTS.agentic
  else runtimePrompts = { ...DEFAULT_PROMPTS }
  return c.json({ ok: true })
})

// ── GET /api/db/status ────────────────────────────────────────────────────────
app.get('/api/db/status', async (c) => {
  try {
    const allPlates = await getAllPlateEntries(c.env.DB)
    const allDrawings = await getAllDrawingEntries(c.env.DB)
    const alphaCount = allPlates.filter(e => e.type === 'alpha').length
    const numericCount = allPlates.filter(e => e.type === 'numeric').length

    // 파일 목록 조회
    const filesResult = await c.env.DB.prepare('SELECT DISTINCT _fileId as fileId, _filename as filename FROM plates LIMIT 20').all<{ fileId: string, filename: string }>()

    return c.json({
      plate: {
        loaded: allPlates.length > 0,
        count: allPlates.length,
        fileCount: filesResult.results?.length || 0,
        updatedAt: null,
        alphaCount,
        numericCount,
        drawingCount: allDrawings.length,
        filename: filesResult.results?.map(f => f.filename).join(', ') || '',
        sample: allPlates.slice(0, 3).map(e => e.plateNo)
      }
    })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ── GET /api/db/plate/files ───────────────────────────────────────────────────
app.get('/api/db/plate/files', async (c) => {
  try {
    const result = await c.env.DB.prepare(`
      SELECT _fileId as fileId, _filename as filename, _uploadedAt as uploadedAt,
             COUNT(*) as count,
             SUM(CASE WHEN type='alpha' THEN 1 ELSE 0 END) as alphaCount,
             SUM(CASE WHEN type='numeric' THEN 1 ELSE 0 END) as numericCount,
             COUNT(DISTINCT drawingFull) as drawingCount
      FROM plates
      GROUP BY _fileId, _filename, _uploadedAt
    `).all<any>()
    const files = result.results || []
    const totalEntries = files.reduce((sum: number, f: any) => sum + (f.count || 0), 0)
    const drawings = await getAllDrawingEntries(c.env.DB)
    return c.json({ files, totalFiles: files.length, totalEntries, totalDrawings: drawings.length })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ── DELETE /api/db/plate/file/:fileId ─────────────────────────────────────────
app.delete('/api/db/plate/file/:fileId', async (c) => {
  try {
    const fileId = c.req.param('fileId')
    const countResult = await c.env.DB.prepare('SELECT COUNT(*) as n FROM plates WHERE _fileId = ?').bind(fileId).first<{ n: number }>()
    if (!countResult || countResult.n === 0) return c.json({ error: '파일을 찾을 수 없습니다' }, 404)
    await c.env.DB.prepare('DELETE FROM plates WHERE _fileId = ?').bind(fileId).run()
    return c.json({ ok: true, totalEntries: 0 })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ── DELETE /api/db/plate ──────────────────────────────────────────────────────
app.delete('/api/db/plate', async (c) => {
  try {
    await c.env.DB.prepare('DELETE FROM plates').run()
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ── POST /api/db/plate/upload (xlsx → D1) ────────────────────────────────────
// Workers 환경에서 xlsx 파싱은 지원 제한 — base64 인코딩된 xlsx를 받아 간단 파싱
app.post('/api/db/plate/upload', async (c) => {
  try {
    const body = await c.req.json()
    const { entries, filename } = body  // 프론트에서 파싱해서 전송

    if (!Array.isArray(entries) || entries.length === 0) {
      return c.json({ error: 'entries 배열이 필요합니다. 프론트에서 xlsx를 파싱하여 전송하세요.' }, 400)
    }

    const fileId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const uploadedAt = new Date().toISOString()
    const batchSize = 100
    let inserted = 0

    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize)
      const stmts = batch.map((e: any) =>
        c.env.DB.prepare(
          'INSERT OR REPLACE INTO plates (plateNo, heatNo, type, drawingFull, drawingBase, sectionCode, skirtNo, _fileId, _filename, _uploadedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(e.plateNo, e.heatNo, e.type || 'alpha', e.drawingFull || '', e.drawingBase || '', e.sectionCode || '', e.skirtNo || 0, fileId, filename || 'upload', uploadedAt)
      )
      await c.env.DB.batch(stmts)
      inserted += batch.length
    }

    const allDrawings = await getAllDrawingEntries(c.env.DB)
    return c.json({ ok: true, inserted, drawingCount: allDrawings.length, fileId })
  } catch (e: any) {
    console.error('[upload]', e.message)
    return c.json({ error: e.message }, 500)
  }
})

// ── POST /api/db/match ────────────────────────────────────────────────────────
app.post('/api/db/match', async (c) => {
  const { line1, line3 } = await c.req.json()
  const result = await matchWithDBs(c.env.DB, line1, line3)
  return c.json(result)
})

// ── POST /api/db/rematch ──────────────────────────────────────────────────────
app.post('/api/db/rematch', async (c) => {
  const { items } = await c.req.json()
  if (!Array.isArray(items)) return c.json({ error: 'items array required' }, 400)

  const allPlates = await getAllPlateEntries(c.env.DB)
  const dbLoaded = allPlates.length > 0

  const results = await Promise.all(items.map(async ({ id, line1, line3 }: any) => {
    const dbMatch = await matchWithDBs(c.env.DB, line1, line3)
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
  }))

  return c.json({ ok: true, results })
})

// ── POST /api/ocr/standard ────────────────────────────────────────────────────
app.post('/api/ocr/standard', async (c) => {
  const t0 = Date.now()
  try {
    const { imageBase64 } = await c.req.json()
    if (!imageBase64) return c.json({ error: 'imageBase64 required' }, 400)

    const allEntries = await getAllPlateEntries(c.env.DB)
    const hasDB = allEntries.length > 0

    const promptPass1 = runtimePrompts.standard.replace('{{DB_HINTS}}', '')
    const rawPass1 = await callVision(imageBase64, promptPass1, 'gpt-4o-mini', c.env)
    const parsedPass1 = parseOCR(rawPass1)
    const normPass1 = normalizeLines(parsedPass1)

    if (!hasDB) {
      const dbMatch = await matchWithDBs(c.env.DB, normPass1.plateNo, normPass1.drawingNo)
      const result = await buildResult(parsedPass1, 'Standard (gpt-4o-mini)', `${((Date.now()-t0)/1000).toFixed(1)}s`, dbMatch, c.env.DB)
      return c.json({ ...result, _dbHintsBlock: '', _pass1: null })
    }

    const dbHintsBlock = await buildCandidatesBlock(c.env.DB, normPass1.plateNo, normPass1.drawingNo, { topN: 8, threshold: 0.45 })

    let finalParsed: any, finalNorm: any, passLabel: string
    if (dbHintsBlock.trim()) {
      const promptPass2 = runtimePrompts.standard.replace('{{DB_HINTS}}', dbHintsBlock)
      const rawPass2 = await callVision(imageBase64, promptPass2, 'gpt-4o-mini', c.env)
      finalParsed = parseOCR(rawPass2)
      finalNorm = normalizeLines(finalParsed)
      passLabel = 'Standard 2-pass (gpt-4o-mini)'
    } else {
      finalParsed = parsedPass1
      finalNorm = normPass1
      passLabel = 'Standard (gpt-4o-mini)'
    }

    const dbMatch = await matchWithDBs(c.env.DB, finalNorm.plateNo, finalNorm.drawingNo)
    const result = await buildResult(finalParsed, passLabel, `${((Date.now()-t0)/1000).toFixed(1)}s`, dbMatch, c.env.DB)

    return c.json({
      ...result,
      _dbHintsBlock: dbHintsBlock,
      _pass1: { line1: parsedPass1.line1, line2: parsedPass1.line2, line3: parsedPass1.line3, layoutType: parsedPass1.layoutType }
    })
  } catch (e: any) {
    console.error('[standard]', e.message)
    return c.json({ error: e.message }, 500)
  }
})

// ── POST /api/ocr/agentic ──────────────────────────────────────────────────────
app.post('/api/ocr/agentic', async (c) => {
  const t0 = Date.now()
  try {
    const { imageBase64, standardResult } = await c.req.json()
    if (!imageBase64) return c.json({ error: 'imageBase64 required' }, 400)

    let hint = '(No previous OCR pass — reading from scratch)'
    if (standardResult) {
      const pass1Info = standardResult._pass1
        ? `  Pass1(raw):  PlateID="${standardResult._pass1.line1}"  Drawing="${standardResult._pass1.line3}"\n`
        : ''
      const dbStatus = standardResult.refMatch?.matched
        ? `MATCHED (conf=${(standardResult.refMatch.confidence*100).toFixed(0)}%, method=${standardResult.refMatch.method}${standardResult.refMatch.crossValidated ? ' ✓cross' : standardResult.refMatch.crossConflict ? ' ✗conflict' : ''})`
        : 'NOT MATCHED in DB'
      hint = `Previous OCR pass attempted this reading (may contain character errors):\n  layoutType: ${standardResult.layoutType || 'A'}\n  PlateID:    "${standardResult.line1}"\n  Material:   "${standardResult.line2}"\n  Drawing:    "${standardResult.line3}"\n${pass1Info}  DB status:  ${dbStatus}\n⚠ IMPORTANT: The previous pass values above are REFERENCE ONLY — they may have misread characters.\n  Do NOT copy them into your output. Re-read the IMAGE from scratch using stroke-level analysis.\n  Your JSON output must reflect what you actually see in the image, not the previous pass values.`
    }

    let dbHintsBlock = ''
    if (standardResult?._dbHintsBlock) {
      dbHintsBlock = standardResult._dbHintsBlock
    } else {
      const rawPlate = standardResult?.line1 || ''
      const rawDrawing = standardResult?.line3 || ''
      dbHintsBlock = await buildCandidatesBlock(c.env.DB, rawPlate, rawDrawing, { topN: 8, threshold: 0.45 })
    }

    const prompt = runtimePrompts.agentic
      .replace('{{HINT}}', hint)
      .replace('{{DB_HINTS}}', dbHintsBlock)

    const raw = await callVision(imageBase64, prompt, 'gpt-4o', c.env)
    const parsed = parseOCR(raw)
    const norm = normalizeLines(parsed)
    const dbMatch = await matchWithDBs(c.env.DB, norm.plateNo, norm.drawingNo)
    const result = await buildResult(parsed, 'Agentic Vision (gpt-4o)', `${((Date.now()-t0)/1000).toFixed(1)}s`, dbMatch, c.env.DB)

    if (dbMatch.combined?.crossConflict && result.status === 'AUTO_OK') {
      result.status = 'REVIEW'
    }

    return c.json(result)
  } catch (e: any) {
    console.error('[agentic]', e.message)
    return c.json({ error: e.message }, 500)
  }
})

// ─── Debug endpoint ───────────────────────────────────────────────────────────
app.get('/api/debug/schema', async (c) => {
  const results: any = {}
  try {
    const r = await c.env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    results.tables = r.results?.map((t: any) => t.name)
  } catch (e: any) { results.tablesErr = e.message }
  try {
    const r = await c.env.DB.prepare("SELECT COUNT(*) as c FROM plates").first<{ c: number }>()
    results.count = r?.c
  } catch (e: any) { results.countErr = e.message }
  try {
    const r = await c.env.DB.prepare("PRAGMA table_info(plates)").all()
    results.columns = r.results?.map((col: any) => col.name)
  } catch (e: any) { results.columnsErr = e.message }
  results.dbBound = !!c.env.DB
  return c.json(results)
})

// ─── SPA fallback ─────────────────────────────────────────────────────────────
app.get('*', serveStatic({ root: './public', path: '/index.html' }))

export default app
