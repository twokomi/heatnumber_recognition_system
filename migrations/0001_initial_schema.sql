-- Plate Number DB (camelCase column names for direct JS mapping)
CREATE TABLE IF NOT EXISTS plates (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  plateNo      TEXT NOT NULL,
  heatNo       TEXT NOT NULL,
  type         TEXT NOT NULL,       -- 'alpha' | 'numeric'
  drawingFull  TEXT,
  drawingBase  TEXT,
  sectionCode  TEXT,
  skirtNo      INTEGER,
  _fileId      TEXT,
  _filename    TEXT,
  _uploadedAt  TEXT,
  createdAt    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_plates_plateNo      ON plates(plateNo);
CREATE INDEX IF NOT EXISTS idx_plates_heatNo       ON plates(heatNo);
CREATE INDEX IF NOT EXISTS idx_plates_drawingFull  ON plates(drawingFull);
CREATE INDEX IF NOT EXISTS idx_plates_drawingBase  ON plates(drawingBase);
CREATE INDEX IF NOT EXISTS idx_plates_type         ON plates(type);
CREATE INDEX IF NOT EXISTS idx_plates_fileId       ON plates(_fileId);
