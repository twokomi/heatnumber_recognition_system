#!/usr/bin/env python3
"""
Excel DB 파서 — 4 Projects SP Hardstamp Details 형식 처리
Usage: python3 parse_excel.py <excel_path> <output_entries_path> <output_meta_path> <file_id> <filename>
"""
import sys
import json
import re
import pandas as pd

def get_plate_type(plate):
    plate = str(plate).strip().upper()
    if re.match(r'^[AB]\d[A-Z]\d{3}-', plate): return 'alpha'
    if re.match(r'^\d{7}-', plate): return 'numeric'
    return 'unknown'

def extract_heat(plate):
    plate = str(plate).strip().upper()
    m = re.match(r'^([AB]\d[A-Z]\d{3})-', plate)
    if m: return m.group(1)
    m = re.match(r'^(\d{7})-', plate)
    if m: return m.group(1)
    return None

def extract_skirt(s):
    s = str(s).strip().upper()
    # Pattern A: 4425B02
    m = re.match(r'^[A-Z0-9]+([A-Z])(\d{2})$', s)
    if m: return m.group(1), int(m.group(2))
    # Pattern B: 0422U-08
    m = re.match(r'^[A-Z0-9]+([A-Z])-(\d{1,2})$', s)
    if m: return m.group(1), int(m.group(2))
    # Pattern C: 0422L8
    m = re.match(r'^[A-Z0-9]+([A-Z])(\d{1})$', s)
    if m: return m.group(1), int(m.group(2))
    return None, None

def parse_excel(xlsx_path, file_id, filename):
    df = pd.read_excel(xlsx_path, engine='openpyxl', dtype=str)
    cols = list(df.columns)

    # 컬럼 자동 감지
    def find_col(exact_candidates, fallback=None):
        cl_map = {c.strip().lower().replace(' ','').replace('#','').replace('_',''): c for c in cols}
        for cand in exact_candidates:
            if cand in cl_map: return cl_map[cand]
        if fallback:
            for cand in fallback:
                for orig, norm in cl_map.items():
                    if cand in orig: return norm
        return None

    col_hp    = find_col(['heavyplate#', 'heavyplate']) or 'HeavyPlate#'
    col_skirt = find_col(['skirtno#', 'skirtno'], ['skirt']) or 'SkirtNo#'
    col_heat  = find_col(['heats', 'heat#'], ['heat']) or 'Heats'
    col_plate = find_col(['plateid', 'plate id']) or 'PlateID'

    entries = []
    seen_plates = set()
    skipped = 0

    for _, row in df.iterrows():
        raw_hp    = str(row.get(col_hp, '') or '').strip().replace(' ', '')
        raw_skirt = str(row.get(col_skirt, '') or '').strip().upper()
        raw_heat  = str(row.get(col_heat, '') or '').strip().upper()
        raw_plate = str(row.get(col_plate, '') or '').strip().upper()

        if not raw_plate or not raw_heat or raw_plate in ('NAN', '') or raw_heat in ('NAN', ''):
            skipped += 1; continue
        if re.match(r'^\d+$', raw_plate):
            skipped += 1; continue

        p_type = get_plate_type(raw_plate)
        heat_no = extract_heat(raw_plate) or raw_heat
        if not heat_no:
            skipped += 1; continue

        drawing_full = None
        drawing_base = None
        section_code = None
        skirt_no     = None

        m = re.match(r'^(\d{8})-([A-Z])(\d{2})$', raw_hp)
        if m:
            drawing_base = m.group(1)
            section_code = m.group(2)
            skirt_no     = int(m.group(3))
            drawing_full = raw_hp
        else:
            m2 = re.match(r'^(\d{8})$', raw_hp)
            if m2:
                drawing_base = m2.group(1)
                sec, pos = extract_skirt(raw_skirt)
                if sec and pos:
                    section_code = sec
                    skirt_no     = pos
                    drawing_full = f"{drawing_base}-{sec}{str(pos).zfill(2)}"

        if raw_plate in seen_plates:
            skipped += 1; continue
        seen_plates.add(raw_plate)

        entries.append({
            'plateNo': raw_plate,
            'heatNo': heat_no,
            'type': p_type,
            'drawingFull': drawing_full,
            'drawingBase': drawing_base,
            'sectionCode': section_code,
            'skirtNo': skirt_no,
            '_fileId': file_id,
        })

    alpha_count   = sum(1 for e in entries if e['type'] == 'alpha')
    numeric_count = sum(1 for e in entries if e['type'] == 'numeric')
    drawing_count = sum(1 for e in entries if e['drawingFull'])

    return {
        'entries': entries,
        'meta': {
            'fileId': file_id,
            'filename': filename,
            'count': len(entries),
            'alphaCount': alpha_count,
            'numericCount': numeric_count,
            'drawingCount': drawing_count,
            'skipped': skipped,
            'format': 'new',
        }
    }

if __name__ == '__main__':
    if len(sys.argv) < 6:
        print(json.dumps({'error': 'Usage: parse_excel.py <xlsx> <entries_out> <meta_out> <file_id> <filename>'}))
        sys.exit(1)

    xlsx_path    = sys.argv[1]
    entries_path = sys.argv[2]
    meta_path    = sys.argv[3]
    file_id      = sys.argv[4]
    filename     = sys.argv[5]

    try:
        result = parse_excel(xlsx_path, file_id, filename)
        with open(entries_path, 'w') as f:
            json.dump(result['entries'], f, ensure_ascii=False)
        with open(meta_path, 'w') as f:
            json.dump(result['meta'], f, ensure_ascii=False)
        print(json.dumps({'ok': True, **result['meta']}))
    except Exception as e:
        print(json.dumps({'error': str(e)}))
        sys.exit(1)
