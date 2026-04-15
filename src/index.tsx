import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  OPENAI_API_KEY: string
  OPENAI_BASE_URL: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('*', cors())

// ─── Heat Number 패턴 검증 ───────────────────────────────────────────────────
function validateHeatNumber(val: string): { valid: boolean; corrected: string } {
  // 패턴: [A|B][숫자][알파벳][3자리숫자]-[알파벳][2자리숫자]-A[2자리숫자]
  // 예: B5L779-C12-A01, A5H217-C13-A01
  const pattern = /^[AB]\d[A-Z]\d{3}-[A-Z]\d{2}-A\d{2}$/
  const cleaned = val.toUpperCase().replace(/\s/g, '')
  return { valid: pattern.test(cleaned), corrected: cleaned }
}

function validateMaterial(val: string): { valid: boolean; corrected: string } {
  const cleaned = val.toUpperCase().replace(/\s+/g, ' ').trim()
  const isValid = cleaned.includes('S355') && cleaned.includes('SSAB')
  return { valid: isValid, corrected: cleaned }
}

function validateDrawingNumber(val: string): { valid: boolean; corrected: string } {
  // 패턴: 8자리숫자-[B|L|M|U|W|T][01-11]
  const pattern = /^\d{8}-[BLMUWT](0[1-9]|1[01])$/
  const cleaned = val.toUpperCase().replace(/\s/g, '')
  return { valid: pattern.test(cleaned), corrected: cleaned }
}

function calcDifficulty(confidence: number): number {
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

// ─── OCR API (Standard - gpt-5-mini) ─────────────────────────────────────────
app.post('/api/ocr/standard', async (c) => {
  const startTime = Date.now()
  try {
    const body = await c.req.json()
    const { imageBase64, imageUrl } = body

    const apiKey = c.env?.OPENAI_API_KEY || process.env.GENSPARK_TOKEN
    const baseURL = c.env?.OPENAI_BASE_URL || 'https://www.genspark.ai/api/llm_proxy/v1'

    const imageContent = imageUrl
      ? { type: 'image_url', image_url: { url: imageUrl } }
      : { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }

    const prompt = `You are an OCR specialist for steel plate dot-matrix stamped text (타각 문자).

Read EXACTLY 3 lines from the steel plate image:

LINE 1 - Heat Number pattern: [A or B][digit][Letter][3digits]-[Letter][2digits]-A[2digits]
  Examples: B5L779-C12-A01, A5H217-C13-A01, B5G610-C14-A02
  
LINE 2 - Material: Always "S355J0+N" or "S355J2+N" followed by "SSAB"
  
LINE 3 - Drawing Number: Exactly 8 digits + hyphen + [B,L,M,U,W,T] + [01-11]
  Examples: 29308316-B01, 29303342-B03, 29311971-T11

Return ONLY valid JSON (no markdown, no explanation):
{
  "line1": "...",
  "line2": "...", 
  "line3": "...",
  "confidence": 0.0-1.0,
  "notes": "brief observation about image quality"
}`

    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-5-mini',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              imageContent,
            ],
          },
        ],
        max_tokens: 300,
        temperature: 0.1,
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      return c.json({ error: `OpenAI API error: ${err}` }, 500)
    }

    const data = await response.json() as any
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    const rawContent = data.choices?.[0]?.message?.content || '{}'

    let parsed: any = {}
    try {
      const jsonMatch = rawContent.match(/\{[\s\S]*\}/)
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawContent)
    } catch {
      parsed = { line1: '', line2: '', line3: '', confidence: 0, notes: rawContent }
    }

    // 패턴 검증 및 보정
    const heatValidation = validateHeatNumber(parsed.line1 || '')
    const matValidation = validateMaterial(parsed.line2 || '')
    const drawValidation = validateDrawingNumber(parsed.line3 || '')

    const validationScore = [heatValidation.valid, matValidation.valid, drawValidation.valid]
      .filter(Boolean).length / 3

    const finalConfidence = (parsed.confidence || 0.5) * 0.7 + validationScore * 0.3
    const difficulty = calcDifficulty(finalConfidence)

    return c.json({
      method: 'Standard (gpt-5-mini)',
      elapsed: `${elapsed}s`,
      line1: heatValidation.corrected || parsed.line1 || '',
      line2: matValidation.corrected || parsed.line2 || '',
      line3: drawValidation.corrected || parsed.line3 || '',
      confidence: Math.round(finalConfidence * 100) / 100,
      difficulty,
      validation: {
        heat: heatValidation.valid,
        material: matValidation.valid,
        drawing: drawValidation.valid,
      },
      notes: parsed.notes || '',
    })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ─── OCR API (Agentic Vision - gpt-5) ────────────────────────────────────────
app.post('/api/ocr/agentic', async (c) => {
  const startTime = Date.now()
  try {
    const body = await c.req.json()
    const { imageBase64, imageUrl, standardResult } = body

    const apiKey = c.env?.OPENAI_API_KEY || process.env.GENSPARK_TOKEN
    const baseURL = c.env?.OPENAI_BASE_URL || 'https://www.genspark.ai/api/llm_proxy/v1'

    const imageContent = imageUrl
      ? { type: 'image_url', image_url: { url: imageUrl } }
      : { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }

    const standardInfo = standardResult
      ? `A previous OCR pass read: Line1="${standardResult.line1}", Line2="${standardResult.line2}", Line3="${standardResult.line3}". Use this as a reference but verify carefully.`
      : ''

    const prompt = `You are an expert OCR agent for industrial steel plate markings (타각/도트매트릭스 타각).

${standardInfo}

CRITICAL RULES for reading the 3 stamped lines:

LINE 1 - Heat Number:
- Format: [A|B][1 digit][1 uppercase letter][3 digits]-[1 uppercase letter][2 digits]-A[2 digits]
- First char: ONLY 'A' or 'B' (never numbers, never 8/6/0)
- Example: B5L779-C12-A01

LINE 2 - Steel Grade + Manufacturer:
- Must start with "S355J" followed by "0" or "2", then "+N"  
- Then spaces, then "SSAB" (fixed)
- Example: S355J0+N   SSAB

LINE 3 - Drawing Number:
- Exactly 8 digits + hyphen + one letter [B,L,M,U,W,T] + two digits [01-11]
- Example: 29308316-B01

Image may be rotated - adjust your reading accordingly.
Return ONLY valid JSON:
{
  "line1": "...",
  "line2": "...",
  "line3": "...",
  "confidence": 0.0-1.0,
  "notes": "detailed analysis of difficult characters and image conditions"
}`

    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-5',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              imageContent,
            ],
          },
        ],
        max_tokens: 500,
        temperature: 0.05,
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      return c.json({ error: `OpenAI API error: ${err}` }, 500)
    }

    const data = await response.json() as any
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    const rawContent = data.choices?.[0]?.message?.content || '{}'

    let parsed: any = {}
    try {
      const jsonMatch = rawContent.match(/\{[\s\S]*\}/)
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawContent)
    } catch {
      parsed = { line1: '', line2: '', line3: '', confidence: 0, notes: rawContent }
    }

    const heatValidation = validateHeatNumber(parsed.line1 || '')
    const matValidation = validateMaterial(parsed.line2 || '')
    const drawValidation = validateDrawingNumber(parsed.line3 || '')

    const validationScore = [heatValidation.valid, matValidation.valid, drawValidation.valid]
      .filter(Boolean).length / 3
    const finalConfidence = (parsed.confidence || 0.5) * 0.7 + validationScore * 0.3
    const difficulty = calcDifficulty(finalConfidence)

    return c.json({
      method: 'Agentic Vision (gpt-5)',
      elapsed: `${elapsed}s`,
      line1: heatValidation.corrected || parsed.line1 || '',
      line2: matValidation.corrected || parsed.line2 || '',
      line3: drawValidation.corrected || parsed.line3 || '',
      confidence: Math.round(finalConfidence * 100) / 100,
      difficulty,
      validation: {
        heat: heatValidation.valid,
        material: matValidation.valid,
        drawing: drawValidation.valid,
      },
      notes: parsed.notes || '',
    })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ─── 메인 HTML 페이지 ─────────────────────────────────────────────────────────
app.get('/', (c) => {
  return c.html(HTML_PAGE)
})

const HTML_PAGE = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CS Wind Heat Number OCR</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <style>
    :root {
      --bg-primary: #0d1117;
      --bg-card: #161b22;
      --bg-card-hover: #1c2128;
      --border: #30363d;
      --text-primary: #e6edf3;
      --text-secondary: #8b949e;
      --blue: #58a6ff;
      --purple: #bc8cff;
      --green: #3fb950;
      --yellow: #d29922;
      --orange: #f0883e;
      --red: #f85149;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg-primary);
      color: var(--text-primary);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', monospace;
      min-height: 100vh;
    }
    /* ── 스크롤바 ── */
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: var(--bg-primary); }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

    /* ── 헤더 ── */
    .header { padding: 24px 32px 0; border-bottom: 1px solid var(--border); }
    .header h1 { font-size: 1.5rem; font-weight: 700; color: var(--text-primary); }
    .header p { color: var(--text-secondary); font-size: 0.8rem; margin-top: 4px; padding-bottom: 16px; }
    .header a { color: var(--blue); text-decoration: none; }
    .header a:hover { text-decoration: underline; }

    /* ── 탭 ── */
    .tabs { display: flex; gap: 0; border-bottom: 1px solid var(--border); padding: 0 32px; background: var(--bg-primary); }
    .tab-btn {
      padding: 12px 20px; font-size: 0.85rem; color: var(--text-secondary);
      background: none; border: none; border-bottom: 2px solid transparent;
      cursor: pointer; transition: all 0.2s; white-space: nowrap;
    }
    .tab-btn:hover { color: var(--text-primary); }
    .tab-btn.active { color: var(--text-primary); border-bottom-color: var(--blue); }

    /* ── 메인 컨텐츠 ── */
    .main { padding: 24px 32px; }

    /* ── 통계 카드 ── */
    .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
    .stat-card {
      background: var(--bg-card); border: 1px solid var(--border);
      border-radius: 8px; padding: 20px;
    }
    .stat-value { font-size: 2.2rem; font-weight: 700; line-height: 1; margin-bottom: 8px; }
    .stat-label { font-size: 0.7rem; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em; }
    .stat-blue { color: var(--blue); }
    .stat-purple { color: var(--purple); }
    .stat-green { color: var(--green); }
    .stat-yellow { color: var(--yellow); }

    /* ── 업로드 존 ── */
    .upload-section { margin-bottom: 24px; }
    .upload-zone {
      border: 2px dashed var(--border); border-radius: 8px;
      padding: 40px; text-align: center; cursor: pointer;
      transition: all 0.2s; position: relative; background: var(--bg-card);
    }
    .upload-zone:hover, .upload-zone.dragover {
      border-color: var(--blue); background: rgba(88,166,255,0.05);
    }
    .upload-zone input[type=file] {
      position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%;
    }
    .upload-icon { font-size: 2.5rem; color: var(--text-secondary); margin-bottom: 12px; }
    .upload-text { color: var(--text-secondary); font-size: 0.9rem; }
    .upload-text strong { color: var(--blue); }

    /* ── 난이도 분포 ── */
    .difficulty-section { margin-bottom: 24px; }
    .difficulty-section h2 { font-size: 0.95rem; font-weight: 600; margin-bottom: 12px; color: var(--text-primary); }
    .difficulty-bar-wrap {
      display: flex; height: 28px; border-radius: 6px; overflow: hidden; gap: 2px;
    }
    .diff-bar { display: flex; align-items: center; justify-content: center;
      font-size: 0.7rem; font-weight: 600; color: white; transition: all 0.3s; cursor: default; }
    .diff-bar.easy { background: #238636; }
    .diff-bar.medium { background: #d29922; }
    .diff-bar.hard { background: #f85149; }
    .diff-label { font-size: 0.75rem; color: var(--text-secondary); margin-top: 8px; display: flex; gap: 16px; }
    .diff-label span { display: flex; align-items: center; gap: 4px; }
    .dot { width: 10px; height: 10px; border-radius: 2px; }

    /* ── 이미지 그리드 헤더 ── */
    .grid-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
    .grid-header h2 { font-size: 0.95rem; font-weight: 600; }
    .sort-btns { display: flex; gap: 6px; }
    .sort-btn {
      padding: 4px 10px; font-size: 0.72rem; border-radius: 4px;
      border: 1px solid var(--border); background: var(--bg-card);
      color: var(--text-secondary); cursor: pointer; transition: all 0.2s;
      display: flex; align-items: center; gap: 4px;
    }
    .sort-btn:hover { background: var(--bg-card-hover); color: var(--text-primary); }
    .sort-btn.active { background: rgba(88,166,255,0.15); border-color: var(--blue); color: var(--blue); }

    /* ── 이미지 그리드 ── */
    .image-grid { display: flex; flex-direction: column; gap: 8px; }
    .image-card {
      background: var(--bg-card); border: 1px solid var(--border);
      border-radius: 8px; padding: 14px 16px;
      display: flex; align-items: center; gap: 16px;
      cursor: pointer; transition: all 0.2s;
    }
    .image-card:hover { background: var(--bg-card-hover); border-color: #58a6ff44; }
    .image-thumb {
      width: 80px; height: 60px; object-fit: cover;
      border-radius: 4px; border: 1px solid var(--border); flex-shrink: 0;
      background: #1c2128;
    }
    .card-filename { font-size: 0.78rem; color: var(--text-secondary); margin-bottom: 6px; font-family: monospace; }
    .card-lines { display: flex; flex-direction: column; gap: 4px; flex: 1; }
    .card-line { display: flex; align-items: center; gap: 8px; }
    .line-num {
      width: 14px; height: 14px; border-radius: 50%;
      background: rgba(139,148,158,0.2); color: var(--text-secondary);
      font-size: 0.65rem; display: flex; align-items: center; justify-content: center; flex-shrink: 0;
    }
    .line-value { font-size: 0.82rem; font-family: monospace; color: var(--text-primary); font-weight: 500; }
    .card-badges { display: flex; align-items: center; gap: 6px; flex-shrink: 0; flex-direction: column; align-items: flex-end; }
    .badge {
      padding: 2px 8px; border-radius: 3px; font-size: 0.68rem; font-weight: 600; white-space: nowrap;
    }
    .badge-diff-easy   { background: rgba(35,134,54,0.3);  color: #3fb950; border: 1px solid rgba(35,134,54,0.4); }
    .badge-diff-medium { background: rgba(210,153,34,0.3); color: #d29922; border: 1px solid rgba(210,153,34,0.4); }
    .badge-diff-hard   { background: rgba(248,81,73,0.3);  color: #f85149; border: 1px solid rgba(248,81,73,0.4); }
    .badge-conf-high   { background: rgba(63,185,80,0.2);  color: #3fb950; border: 1px solid rgba(63,185,80,0.3); }
    .badge-conf-medium { background: rgba(210,153,34,0.2); color: #d29922; border: 1px solid rgba(210,153,34,0.3); }
    .badge-conf-low    { background: rgba(248,81,73,0.2);  color: #f85149; border: 1px solid rgba(248,81,73,0.3); }
    .badge-agentic  { background: rgba(188,140,255,0.2); color: #bc8cff; border: 1px solid rgba(188,140,255,0.3); }

    /* ── Processing 애니메이션 ── */
    .processing-card { border-color: rgba(88,166,255,0.4) !important; }
    .pulse { animation: pulse 1.5s ease-in-out infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
    .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--border);
      border-top-color: var(--blue); border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── 모달 ── */
    .modal-overlay {
      position: fixed; inset: 0; background: rgba(1,4,9,0.85);
      display: flex; align-items: center; justify-content: center;
      z-index: 1000; padding: 20px; backdrop-filter: blur(4px);
    }
    .modal-overlay.hidden { display: none; }
    .modal {
      background: var(--bg-card); border: 1px solid var(--border);
      border-radius: 12px; width: 100%; max-width: 900px; max-height: 90vh;
      overflow-y: auto; position: relative;
    }
    .modal-header {
      padding: 20px 24px 16px; border-bottom: 1px solid var(--border);
      display: flex; align-items: flex-start; justify-content: space-between; gap: 16px;
      position: sticky; top: 0; background: var(--bg-card); z-index: 10;
    }
    .modal-header h2 { font-size: 0.85rem; font-family: monospace; color: var(--text-secondary); margin-bottom: 8px; }
    .modal-header-badges { display: flex; gap: 6px; flex-wrap: wrap; }
    .modal-close {
      background: none; border: 1px solid var(--border); color: var(--text-secondary);
      width: 28px; height: 28px; border-radius: 4px; cursor: pointer;
      font-size: 0.9rem; flex-shrink: 0; transition: all 0.2s;
    }
    .modal-close:hover { background: var(--bg-card-hover); color: var(--text-primary); }
    .modal-body { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
    .modal-image-side {
      padding: 20px; border-right: 1px solid var(--border);
      display: flex; flex-direction: column; gap: 16px;
    }
    .modal-image-side img {
      width: 100%; border-radius: 8px; border: 1px solid var(--border);
      max-height: 300px; object-fit: contain; background: #0d1117;
    }
    .final-result { background: rgba(88,166,255,0.08); border: 1px solid rgba(88,166,255,0.2); border-radius: 8px; padding: 16px; }
    .final-result h3 { font-size: 0.75rem; color: var(--blue); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px; }
    .result-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
    .result-row:last-child { margin-bottom: 0; }
    .result-num {
      width: 20px; height: 20px; border-radius: 50%; background: rgba(88,166,255,0.2);
      color: var(--blue); font-size: 0.7rem; font-weight: 700;
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
    }
    .result-val { font-family: monospace; font-size: 0.9rem; font-weight: 600; color: var(--text-primary); }
    .result-check { margin-left: auto; font-size: 0.8rem; }
    .check-ok { color: var(--green); }
    .check-fail { color: var(--red); }
    .modal-results-side { padding: 20px; display: flex; flex-direction: column; gap: 16px; }
    .method-block { background: var(--bg-primary); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
    .method-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
    .method-title { font-size: 0.78rem; font-weight: 600; }
    .method-title.standard { color: #58a6ff; }
    .method-title.agentic { color: #bc8cff; }
    .method-elapsed { font-size: 0.7rem; color: var(--text-secondary); }
    .method-lines { display: flex; flex-direction: column; gap: 6px; }
    .method-line { display: flex; align-items: flex-start; gap: 8px; }
    .method-line-num {
      width: 16px; height: 16px; border-radius: 50%;
      background: rgba(139,148,158,0.15); color: var(--text-secondary);
      font-size: 0.62rem; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 1px;
    }
    .method-line-val { font-family: monospace; font-size: 0.82rem; color: var(--text-primary); word-break: break-all; }
    .method-notes {
      margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border);
      font-size: 0.75rem; color: var(--text-secondary); line-height: 1.5;
    }
    .agentic-btn {
      width: 100%; padding: 10px; font-size: 0.82rem; font-weight: 600;
      background: rgba(188,140,255,0.15); border: 1px solid rgba(188,140,255,0.3);
      color: #bc8cff; border-radius: 6px; cursor: pointer; transition: all 0.2s;
      display: flex; align-items: center; justify-content: center; gap: 8px;
    }
    .agentic-btn:hover { background: rgba(188,140,255,0.25); }
    .agentic-btn:disabled { opacity: 0.5; cursor: not-allowed; }

    /* ── 검증 배지 ── */
    .validation-row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
    .val-badge {
      padding: 2px 8px; border-radius: 3px; font-size: 0.68rem; font-weight: 600;
    }
    .val-ok  { background: rgba(63,185,80,0.2);  color: #3fb950; border: 1px solid rgba(63,185,80,0.3); }
    .val-fail{ background: rgba(248,81,73,0.2);  color: #f85149; border: 1px solid rgba(248,81,73,0.3); }

    /* ── 네비게이션 버튼 ── */
    .modal-nav {
      display: flex; align-items: center; justify-content: space-between;
      padding: 16px 24px; border-top: 1px solid var(--border);
    }
    .nav-btn {
      padding: 8px 16px; font-size: 0.82rem;
      background: var(--bg-card-hover); border: 1px solid var(--border);
      color: var(--text-primary); border-radius: 6px; cursor: pointer; transition: all 0.2s;
      display: flex; align-items: center; gap: 6px;
    }
    .nav-btn:hover { border-color: var(--blue); color: var(--blue); }
    .nav-btn:disabled { opacity: 0.3; cursor: not-allowed; }
    .nav-position { font-size: 0.78rem; color: var(--text-secondary); }

    /* ── 빈 상태 ── */
    .empty-state { text-align: center; padding: 60px 20px; color: var(--text-secondary); }
    .empty-state i { font-size: 3rem; margin-bottom: 16px; display: block; }

    /* ── 반응형 ── */
    @media (max-width: 768px) {
      .stats-grid { grid-template-columns: repeat(2, 1fr); }
      .modal-body { grid-template-columns: 1fr; }
      .modal-image-side { border-right: none; border-bottom: 1px solid var(--border); }
      .main { padding: 16px; }
      .header { padding: 16px 16px 0; }
      .tabs { padding: 0 16px; }
    }
  </style>
</head>
<body>

<!-- 헤더 -->
<div class="header">
  <h1><i class="fas fa-layer-group" style="color:#58a6ff;margin-right:8px"></i>CS Wind Heat Number OCR</h1>
  <p id="header-subtitle">이미지를 업로드하면 철판 타각 문자를 자동으로 판독합니다. — <span id="gen-time"></span></p>
</div>

<!-- 탭 -->
<div class="tabs">
  <button class="tab-btn active" onclick="switchTab('dashboard')">
    <i class="fas fa-chart-bar" style="margin-right:5px"></i>Dashboard
  </button>
  <button class="tab-btn" onclick="switchTab('upload')">
    <i class="fas fa-upload" style="margin-right:5px"></i>Upload
  </button>
</div>

<!-- 메인 -->
<div class="main">

  <!-- 통계 카드 -->
  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-value stat-blue" id="stat-total">0</div>
      <div class="stat-label">Total Images</div>
    </div>
    <div class="stat-card">
      <div class="stat-value stat-purple" id="stat-agentic">0</div>
      <div class="stat-label">Used Agentic</div>
    </div>
    <div class="stat-card">
      <div class="stat-value stat-green" id="stat-high-conf">0</div>
      <div class="stat-label">High Confidence</div>
    </div>
    <div class="stat-card">
      <div class="stat-value stat-yellow" id="stat-avg-diff">—</div>
      <div class="stat-label">Avg Difficulty /10</div>
    </div>
  </div>

  <!-- 업로드 탭 -->
  <div id="tab-upload" class="upload-section" style="display:none">
    <div class="upload-zone" id="upload-zone">
      <input type="file" id="file-input" accept="image/*" multiple>
      <div class="upload-icon"><i class="fas fa-cloud-upload-alt"></i></div>
      <div class="upload-text">
        <strong>파일 선택</strong> 또는 드래그 앤 드롭<br>
        <span style="font-size:0.78rem;margin-top:4px;display:block">JPG, PNG, HEIC 지원 · 여러 파일 동시 업로드 가능</span>
      </div>
    </div>
  </div>

  <!-- 난이도 분포 -->
  <div class="difficulty-section">
    <h2>Difficulty Distribution</h2>
    <div class="difficulty-bar-wrap" id="diff-bar">
      <div class="diff-bar easy" style="flex:1">No data</div>
    </div>
    <div class="diff-label">
      <span><span class="dot" style="background:#238636"></span>Easy (1-3)</span>
      <span><span class="dot" style="background:#d29922"></span>Medium (4-6)</span>
      <span><span class="dot" style="background:#f85149"></span>Hard (7+)</span>
    </div>
  </div>

  <!-- 이미지 그리드 -->
  <div>
    <div class="grid-header">
      <h2>All Images</h2>
      <div class="sort-btns">
        <button class="sort-btn active" id="sort-hardest" onclick="sortImages('hardest')">
          <i class="fas fa-arrow-down"></i> Hardest first
        </button>
        <button class="sort-btn" id="sort-easiest" onclick="sortImages('easiest')">
          <i class="fas fa-arrow-up"></i> Easiest first
        </button>
      </div>
    </div>
    <div class="image-grid" id="image-grid">
      <div class="empty-state">
        <i class="fas fa-image"></i>
        <p>Upload 탭에서 이미지를 업로드하면 결과가 여기에 표시됩니다</p>
      </div>
    </div>
  </div>
</div>

<!-- 모달 -->
<div class="modal-overlay hidden" id="modal-overlay" onclick="closeModalOutside(event)">
  <div class="modal" id="modal">
    <div class="modal-header">
      <div>
        <h2 id="modal-filename">파일명</h2>
        <div class="modal-header-badges" id="modal-badges"></div>
      </div>
      <button class="modal-close" onclick="closeModal()"><i class="fas fa-times"></i></button>
    </div>
    <div class="modal-body">
      <!-- 이미지 + 최종 결과 -->
      <div class="modal-image-side">
        <img id="modal-img" src="" alt="Steel plate">
        <div class="final-result">
          <h3><i class="fas fa-check-circle" style="margin-right:6px"></i>Final OCR Result</h3>
          <div class="result-row">
            <div class="result-num">1</div>
            <div class="result-val" id="modal-final-1">—</div>
            <span class="result-check" id="modal-check-1"></span>
          </div>
          <div class="result-row">
            <div class="result-num">2</div>
            <div class="result-val" id="modal-final-2">—</div>
            <span class="result-check" id="modal-check-2"></span>
          </div>
          <div class="result-row">
            <div class="result-num">3</div>
            <div class="result-val" id="modal-final-3">—</div>
            <span class="result-check" id="modal-check-3"></span>
          </div>
        </div>
      </div>

      <!-- OCR 상세 결과 -->
      <div class="modal-results-side">
        <!-- Standard -->
        <div class="method-block">
          <div class="method-header">
            <span class="method-title standard">
              <i class="fas fa-bolt" style="margin-right:4px"></i>Standard (gpt-5-mini)
            </span>
            <span class="method-elapsed" id="modal-std-elapsed">—</span>
          </div>
          <div class="method-lines" id="modal-std-lines">
            <div class="method-line">
              <span class="method-line-num">1</span>
              <span class="method-line-val" id="modal-std-1">—</span>
            </div>
            <div class="method-line">
              <span class="method-line-num">2</span>
              <span class="method-line-val" id="modal-std-2">—</span>
            </div>
            <div class="method-line">
              <span class="method-line-num">3</span>
              <span class="method-line-val" id="modal-std-3">—</span>
            </div>
          </div>
          <div class="validation-row" id="modal-std-validation"></div>
          <div class="method-notes" id="modal-std-notes"></div>
        </div>

        <!-- Agentic Vision -->
        <div class="method-block" id="modal-agentic-block">
          <div class="method-header">
            <span class="method-title agentic">
              <i class="fas fa-eye" style="margin-right:4px"></i>Agentic Vision (gpt-5)
            </span>
            <span class="method-elapsed" id="modal-agn-elapsed">—</span>
          </div>
          <div class="method-lines" id="modal-agn-lines">
            <div style="color:var(--text-secondary);font-size:0.8rem;padding:8px 0">
              아직 실행되지 않았습니다
            </div>
          </div>
          <div class="validation-row" id="modal-agn-validation"></div>
          <div class="method-notes" id="modal-agn-notes"></div>
          <button class="agentic-btn" id="agentic-run-btn" onclick="runAgentic()" style="margin-top:12px">
            <i class="fas fa-magic"></i>
            Agentic Vision 실행 (고정밀)
          </button>
        </div>
      </div>
    </div>

    <!-- 네비게이션 -->
    <div class="modal-nav">
      <button class="nav-btn" id="nav-prev" onclick="navigateModal(-1)">
        <i class="fas fa-chevron-left"></i> 이전
      </button>
      <span class="nav-position" id="nav-position">1 / 1</span>
      <button class="nav-btn" id="nav-next" onclick="navigateModal(1)">
        다음 <i class="fas fa-chevron-right"></i>
      </button>
    </div>
  </div>
</div>

<script>
// ─── 상태 관리 ────────────────────────────────────────────────────────────────
let images = [] // {id, filename, dataUrl, standardResult, agenticResult, status}
let sortMode = 'hardest'
let currentModalIdx = -1

// 날짜/시간 표시
document.getElementById('gen-time').textContent = 'Generated ' + new Date().toLocaleString('ko-KR')

// ─── 탭 전환 ─────────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b,i) => {
    b.classList.toggle('active', (i === 0 && tab==='dashboard') || (i===1 && tab==='upload'))
  })
  document.getElementById('tab-upload').style.display = tab === 'upload' ? 'block' : 'none'
}

// ─── 파일 업로드 ──────────────────────────────────────────────────────────────
const fileInput = document.getElementById('file-input')
const uploadZone = document.getElementById('upload-zone')

fileInput.addEventListener('change', e => handleFiles(e.target.files))

uploadZone.addEventListener('dragover', e => {
  e.preventDefault(); uploadZone.classList.add('dragover')
})
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'))
uploadZone.addEventListener('drop', e => {
  e.preventDefault(); uploadZone.classList.remove('dragover')
  handleFiles(e.dataTransfer.files)
})

function handleFiles(files) {
  if (!files || files.length === 0) return
  switchTab('dashboard')
  Array.from(files).forEach(file => {
    const reader = new FileReader()
    reader.onload = e => {
      const img = {
        id: Date.now() + Math.random(),
        filename: file.name,
        dataUrl: e.target.result,
        standardResult: null,
        agenticResult: null,
        status: 'processing'
      }
      images.push(img)
      renderGrid()
      runStandard(img)
    }
    reader.readAsDataURL(file)
  })
}

// ─── Standard OCR 실행 ───────────────────────────────────────────────────────
async function runStandard(img) {
  try {
    const base64 = img.dataUrl.split(',')[1]
    const res = await fetch('/api/ocr/standard', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ imageBase64: base64 })
    })
    const data = await res.json()
    img.standardResult = data
    img.status = 'done'
  } catch(e) {
    img.standardResult = { error: e.message, line1:'', line2:'', line3:'', confidence:0, difficulty:10 }
    img.status = 'error'
  }
  renderGrid()
  updateStats()
}

// ─── Agentic OCR 실행 (모달에서) ─────────────────────────────────────────────
async function runAgentic() {
  const img = images[currentModalIdx]
  if (!img) return

  const btn = document.getElementById('agentic-run-btn')
  btn.disabled = true
  btn.innerHTML = '<span class="spinner"></span> 분석 중...'

  document.getElementById('modal-agn-elapsed').textContent = '실행 중...'
  document.getElementById('modal-agn-lines').innerHTML =
    '<div style="color:var(--text-secondary);font-size:0.8rem;padding:8px 0"><span class="pulse">⚡ Agentic Vision 분석 중...</span></div>'

  try {
    const base64 = img.dataUrl.split(',')[1]
    const res = await fetch('/api/ocr/agentic', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        imageBase64: base64,
        standardResult: img.standardResult
      })
    })
    const data = await res.json()
    img.agenticResult = data
    renderGrid()
    updateStats()
    populateModal(currentModalIdx)
  } catch(e) {
    img.agenticResult = { error: e.message }
    document.getElementById('modal-agn-lines').innerHTML =
      '<div style="color:var(--red);font-size:0.8rem">오류: ' + e.message + '</div>'
  }
  btn.disabled = false
  btn.innerHTML = '<i class="fas fa-magic"></i> Agentic Vision 재실행'
}

// ─── 그리드 렌더링 ────────────────────────────────────────────────────────────
function getDisplayResult(img) {
  return img.agenticResult || img.standardResult
}

function getDifficulty(img) {
  const r = getDisplayResult(img)
  return r?.difficulty || 10
}

function diffBadgeClass(d) {
  if (d <= 3) return 'badge-diff-easy'
  if (d <= 6) return 'badge-diff-medium'
  return 'badge-diff-hard'
}

function confBadgeClass(c) {
  if (!c) return 'badge-conf-low'
  if (c >= 0.7) return 'badge-conf-high'
  if (c >= 0.4) return 'badge-conf-medium'
  return 'badge-conf-low'
}

function confLabel(c) {
  if (!c) return 'unknown'
  if (c >= 0.7) return 'high'
  if (c >= 0.4) return 'medium'
  return 'low'
}

function renderGrid() {
  const grid = document.getElementById('image-grid')

  if (images.length === 0) {
    grid.innerHTML = '<div class="empty-state"><i class="fas fa-image"></i><p>Upload 탭에서 이미지를 업로드하면 결과가 여기에 표시됩니다</p></div>'
    return
  }

  const sorted = [...images].sort((a,b) => {
    const da = getDifficulty(a), db = getDifficulty(b)
    return sortMode === 'hardest' ? db - da : da - db
  })

  grid.innerHTML = sorted.map((img, idx) => {
    const r = getDisplayResult(img)
    const origIdx = images.indexOf(img)

    if (img.status === 'processing') {
      return \`<div class="image-card processing-card">
        <img class="image-thumb" src="\${img.dataUrl}" alt="">
        <div class="card-lines" style="flex:1">
          <div class="card-filename">\${img.filename}</div>
          <div style="color:var(--text-secondary);font-size:0.82rem">
            <span class="spinner"></span> OCR 분석 중...
          </div>
        </div>
      </div>\`
    }

    const d = getDifficulty(img)
    const conf = r?.confidence || 0
    const hasAgentic = !!img.agenticResult

    return \`<div class="image-card" onclick="openModal(\${origIdx})">
      <img class="image-thumb" src="\${img.dataUrl}" alt="">
      <div style="flex:1;min-width:0">
        <div class="card-filename">\${img.filename}</div>
        <div class="card-lines">
          \${[1,2,3].map(n => \`
          <div class="card-line">
            <span class="line-num">\${n}</span>
            <span class="line-value">\${r?.['line'+n] || '—'}</span>
          </div>\`).join('')}
        </div>
      </div>
      <div class="card-badges">
        <span class="badge \${diffBadgeClass(d)}">Difficulty \${d}/10</span>
        <span class="badge \${confBadgeClass(conf)}">Confidence: \${confLabel(conf)}</span>
        \${hasAgentic ? '<span class="badge badge-agentic">Agentic Vision</span>' : ''}
      </div>
    </div>\`
  }).join('')

  updateDiffBar()
}

// ─── 난이도 분포 바 ───────────────────────────────────────────────────────────
function updateDiffBar() {
  const done = images.filter(i => i.status === 'done')
  if (done.length === 0) return

  const easy   = done.filter(i => getDifficulty(i) <= 3).length
  const medium = done.filter(i => getDifficulty(i) >= 4 && getDifficulty(i) <= 6).length
  const hard   = done.filter(i => getDifficulty(i) >= 7).length
  const total  = done.length

  document.getElementById('diff-bar').innerHTML =
    (easy   > 0 ? \`<div class="diff-bar easy"   style="flex:\${easy}">\${easy} Easy (1-3)</div>\` : '') +
    (medium > 0 ? \`<div class="diff-bar medium" style="flex:\${medium}">\${medium} Medium (4-6)</div>\` : '') +
    (hard   > 0 ? \`<div class="diff-bar hard"   style="flex:\${hard}">\${hard} Hard (7+)</div>\` : '')
}

// ─── 통계 업데이트 ────────────────────────────────────────────────────────────
function updateStats() {
  const done = images.filter(i => i.status === 'done')
  const agentic = images.filter(i => !!i.agenticResult).length
  const highConf = done.filter(i => (getDisplayResult(i)?.confidence || 0) >= 0.7).length
  const avgDiff = done.length
    ? (done.reduce((s,i) => s + getDifficulty(i), 0) / done.length).toFixed(1)
    : '—'

  document.getElementById('stat-total').textContent = images.length
  document.getElementById('stat-agentic').textContent = agentic + (agentic > 0 ? \` (\${agentic}/\${images.length})\` : '')
  document.getElementById('stat-high-conf').textContent = highConf
  document.getElementById('stat-avg-diff').textContent = avgDiff
}

// ─── 정렬 ─────────────────────────────────────────────────────────────────────
function sortImages(mode) {
  sortMode = mode
  document.getElementById('sort-hardest').classList.toggle('active', mode === 'hardest')
  document.getElementById('sort-easiest').classList.toggle('active', mode === 'easiest')
  renderGrid()
}

// ─── 모달 ─────────────────────────────────────────────────────────────────────
function openModal(idx) {
  currentModalIdx = idx
  populateModal(idx)
  document.getElementById('modal-overlay').classList.remove('hidden')
  document.body.style.overflow = 'hidden'
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden')
  document.body.style.overflow = ''
}

function closeModalOutside(e) {
  if (e.target === document.getElementById('modal-overlay')) closeModal()
}

function navigateModal(dir) {
  const newIdx = currentModalIdx + dir
  if (newIdx < 0 || newIdx >= images.length) return
  currentModalIdx = newIdx
  populateModal(newIdx)
}

function populateModal(idx) {
  const img = images[idx]
  if (!img) return

  // 파일명
  document.getElementById('modal-filename').textContent = img.filename

  // 이미지
  document.getElementById('modal-img').src = img.dataUrl

  // 네비게이션
  document.getElementById('nav-prev').disabled = idx === 0
  document.getElementById('nav-next').disabled = idx === images.length - 1
  document.getElementById('nav-position').textContent = \`\${idx+1} / \${images.length}\`

  const r = getDisplayResult(img)
  const d = getDifficulty(img)
  const conf = r?.confidence || 0

  // 헤더 배지
  document.getElementById('modal-badges').innerHTML =
    \`<span class="badge \${diffBadgeClass(d)}">Difficulty \${d}/10</span>
     <span class="badge \${confBadgeClass(conf)}">Confidence: \${confLabel(conf)}</span>
     \${img.agenticResult ? '<span class="badge badge-agentic">Agentic Vision</span>' : ''}\`

  // 최종 결과
  ;[1,2,3].forEach(n => {
    document.getElementById('modal-final-'+n).textContent = r?.['line'+n] || '—'
    const v = r?.validation
    if (v) {
      const ok = n === 1 ? v.heat : (n === 2 ? v.material : v.drawing)
      document.getElementById('modal-check-'+n).innerHTML =
        ok ? '<span class="check-ok">✓</span>' : '<span class="check-fail">✗</span>'
    }
  })

  // Standard 결과
  const std = img.standardResult
  if (std && !std.error) {
    document.getElementById('modal-std-elapsed').textContent = std.elapsed || ''
    ;[1,2,3].forEach(n => {
      document.getElementById('modal-std-'+n).textContent = std['line'+n] || '—'
    })
    const sv = std.validation
    document.getElementById('modal-std-validation').innerHTML = sv ? [
      { key:'heat', label:'Heat#' },
      { key:'material', label:'Material' },
      { key:'drawing', label:'Drawing#' }
    ].map(({key,label}) =>
      \`<span class="val-badge \${sv[key]?'val-ok':'val-fail'}">\${label}: \${sv[key]?'✓':'✗'}</span>\`
    ).join('') : ''
    document.getElementById('modal-std-notes').textContent = std.notes || ''
  }

  // Agentic 결과
  const agn = img.agenticResult
  const agnBlock = document.getElementById('modal-agn-lines')
  const agnValidation = document.getElementById('modal-agn-validation')
  const agnNotes = document.getElementById('modal-agn-notes')
  const btn = document.getElementById('agentic-run-btn')

  if (agn && !agn.error) {
    document.getElementById('modal-agn-elapsed').textContent = agn.elapsed || ''
    agnBlock.innerHTML = [1,2,3].map(n => \`
      <div class="method-line">
        <span class="method-line-num">\${n}</span>
        <span class="method-line-val">\${agn['line'+n] || '—'}</span>
      </div>\`).join('')
    const av = agn.validation
    agnValidation.innerHTML = av ? [
      { key:'heat', label:'Heat#' },
      { key:'material', label:'Material' },
      { key:'drawing', label:'Drawing#' }
    ].map(({key,label}) =>
      \`<span class="val-badge \${av[key]?'val-ok':'val-fail'}">\${label}: \${av[key]?'✓':'✗'}</span>\`
    ).join('') : ''
    agnNotes.textContent = agn.notes || ''
    btn.innerHTML = '<i class="fas fa-magic"></i> Agentic Vision 재실행'
    btn.disabled = false
  } else if (!agn) {
    agnBlock.innerHTML = '<div style="color:var(--text-secondary);font-size:0.8rem;padding:8px 0">아직 실행되지 않았습니다</div>'
    agnValidation.innerHTML = ''
    agnNotes.textContent = ''
    btn.innerHTML = '<i class="fas fa-magic"></i> Agentic Vision 실행 (고정밀)'
    btn.disabled = false
  }
}

// ─── 키보드 네비게이션 ────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (document.getElementById('modal-overlay').classList.contains('hidden')) return
  if (e.key === 'ArrowLeft')  navigateModal(-1)
  if (e.key === 'ArrowRight') navigateModal(1)
  if (e.key === 'Escape')     closeModal()
})
</script>
</body>
</html>`

export default app
