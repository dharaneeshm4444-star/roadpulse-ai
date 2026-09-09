import { useState, useRef, useCallback, useEffect } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";
import { Upload, MapPin, Camera, AlertTriangle, CheckCircle2, Clock, Trash2, Navigation, RotateCcw } from "lucide-react";

const ASPHALT = "#1C1B1F";
const ROAD_GRAY = "#4A4A52";
const AMBER = "#F2A93B";
const RED = "#D64545";
const PAPER = "#F7F5F0";
const GREEN = "#4C8C5C";

const CATEGORIES = ["Pothole", "Surface Crack", "Waterlogging", "Debris / Obstruction", "Faded Lane Marking", "Damaged Signage", "Other"];
const SEVERITIES = ["Low", "Medium", "High"];
const STATUSES = ["Reported", "Verified", "Resolved"];

const SEVERITY_COLOR = { Low: "#8B9A6B", Medium: AMBER, High: RED };
const STATUS_ICON = { Reported: Clock, Verified: AlertTriangle, Resolved: CheckCircle2 };

function uid() {
  return "rp_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

// --- Heuristic "detector": grid-based dark/high-variance blob finder ---
function analyzeImage(img) {
  const W = 320;
  const H = Math.round((img.naturalHeight / img.naturalWidth) * W) || 240;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, W, H);
  const { data } = ctx.getImageData(0, 0, W, H);

  const gray = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }

  const cell = 16;
  const cols = Math.floor(W / cell);
  const rows = Math.floor(H / cell);
  const cellMean = new Float32Array(cols * rows);
  const cellVar = new Float32Array(cols * rows);

  let globalSum = 0;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let sum = 0, sumSq = 0, n = 0;
      for (let y = cy * cell; y < cy * cell + cell; y++) {
        for (let x = cx * cell; x < cx * cell + cell; x++) {
          const v = gray[y * W + x];
          sum += v; sumSq += v * v; n++;
        }
      }
      const mean = sum / n;
      const variance = sumSq / n - mean * mean;
      cellMean[cy * cols + cx] = mean;
      cellVar[cy * cols + cx] = variance;
      globalSum += mean;
    }
  }
  const globalMean = globalSum / (cols * rows);

  const anomaly = new Uint8Array(cols * rows);
  for (let i = 0; i < cols * rows; i++) {
    const darkness = globalMean - cellMean[i];
    const texture = cellVar[i];
    if (darkness > 18 && texture > 250) anomaly[i] = 1;
  }

  const visited = new Uint8Array(cols * rows);
  const blobs = [];
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const idx = cy * cols + cx;
      if (!anomaly[idx] || visited[idx]) continue;
      const stack = [[cx, cy]];
      visited[idx] = 1;
      let minX = cx, maxX = cx, minY = cy, maxY = cy, count = 0, darkSum = 0;
      while (stack.length) {
        const [x, y] = stack.pop();
        const id = y * cols + x;
        count++;
        darkSum += globalMean - cellMean[id];
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        [[1,0],[-1,0],[0,1],[0,-1]].forEach(([dx, dy]) => {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < cols && ny >= 0 && ny < rows) {
            const nid = ny * cols + nx;
            if (anomaly[nid] && !visited[nid]) { visited[nid] = 1; stack.push([nx, ny]); }
          }
        });
      }
      if (count >= 2) {
        blobs.push({
          x: minX * cell, y: minY * cell,
          w: (maxX - minX + 1) * cell, h: (maxY - minY + 1) * cell,
          count, avgDark: darkSum / count,
        });
      }
    }
  }

  blobs.sort((a, b) => b.count - a.count);
  const top = blobs.slice(0, 3);
  const areaFrac = top.reduce((s, b) => s + b.count, 0) / (cols * rows);
  const confidence = Math.min(0.97, 0.35 + areaFrac * 4 + (top[0]?.avgDark || 0) / 200);

  let severity = "Low";
  if (areaFrac > 0.12) severity = "High";
  else if (areaFrac > 0.04) severity = "Medium";

  return { boxes: top, W, H, confidence: top.length ? confidence : 0, severity, detected: top.length > 0 };
}

function drawOverlay(canvas, img, result) {
  const ctx = canvas.getContext("2d");
  canvas.width = result.W;
  canvas.height = result.H;
  ctx.drawImage(img, 0, 0, result.W, result.H);
  result.boxes.forEach((b, i) => {
    ctx.strokeStyle = i === 0 ? RED : AMBER;
    ctx.lineWidth = 2;
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.fillStyle = i === 0 ? RED : AMBER;
    ctx.font = "bold 11px system-ui";
    ctx.fillText(i === 0 ? "anomaly" : "", b.x, Math.max(10, b.y - 4));
  });
}

export default function RoadPulse() {
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saveErr, setSaveErr] = useState("");

  const [imgEl, setImgEl] = useState(null);
  const [result, setResult] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [severity, setSeverity] = useState("Low");
  const [location, setLocation] = useState("");
  const [notes, setNotes] = useState("");
  const [filterCat, setFilterCat] = useState("All");
  const [filterStatus, setFilterStatus] = useState("All");

  const canvasRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("road-reports");
      if (raw) setReports(JSON.parse(raw));
    } catch (e) {
      // no existing data yet — fine
    } finally {
      setLoading(false);
    }
  }, []);

  const persist = useCallback((next) => {
    setReports(next);
    try {
      localStorage.setItem("road-reports", JSON.stringify(next));
      setSaveErr("");
    } catch (e) {
      setSaveErr("Couldn't save — data will reset on refresh.");
    }
  }, []);

  const handleFile = (file) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setImgEl(img);
      setAnalyzing(true);
      setTimeout(() => {
        const r = analyzeImage(img);
        setResult(r);
        setCategory(r.detected ? "Pothole" : CATEGORIES[0]);
        setSeverity(r.severity);
        setAnalyzing(false);
        setTimeout(() => canvasRef.current && drawOverlay(canvasRef.current, img, r), 30);
      }, 500);
    };
    img.src = url;
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) { setLocation("Location unavailable"); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => setLocation(`${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`),
      () => setLocation("Location permission denied")
    );
  };

  const submitReport = () => {
    const report = {
      id: uid(),
      category, severity, location: location || "Not specified", notes,
      confidence: result ? Math.round(result.confidence * 100) : null,
      status: "Reported",
      createdAt: new Date().toISOString(),
    };
    persist([report, ...reports]);
    setImgEl(null); setResult(null); setLocation(""); setNotes(""); setCategory(CATEGORIES[0]); setSeverity("Low");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const cycleStatus = (id) => {
    const next = reports.map((r) => {
      if (r.id !== id) return r;
      const i = STATUSES.indexOf(r.status);
      return { ...r, status: STATUSES[(i + 1) % STATUSES.length] };
    });
    persist(next);
  };

  const deleteReport = (id) => persist(reports.filter((r) => r.id !== id));

  const resetDemo = () => { if (confirm("Clear all logged reports?")) persist([]); };

  const filtered = reports.filter(
    (r) => (filterCat === "All" || r.category === filterCat) && (filterStatus === "All" || r.status === filterStatus)
  );

  const catCounts = CATEGORIES.map((c) => ({ name: c.split(" ")[0], value: reports.filter((r) => r.category === c).length })).filter((d) => d.value > 0);
  const sevCounts = SEVERITIES.map((s) => ({ name: s, value: reports.filter((r) => r.severity === s).length })).filter((d) => d.value > 0);
  const highCount = reports.filter((r) => r.severity === "High").length;

  return (
    <div style={{ background: PAPER, minHeight: "100%", fontFamily: "'Inter', system-ui, sans-serif", color: ASPHALT }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap');
        .sg { font-family: 'Space Grotesk', system-ui, sans-serif; }
        .lane-divider { background-image: repeating-linear-gradient(90deg, ${ROAD_GRAY} 0 18px, transparent 18px 30px); height: 2px; opacity: 0.35; }
        select, input, textarea { font-family: inherit; }
        button { font-family: inherit; cursor: pointer; }
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-thumb { background: #d8d4c8; border-radius: 4px; }
      `}</style>

      {/* Header */}
      <div style={{ background: ASPHALT, color: PAPER, padding: "28px 32px" }}>
        <div style={{ maxWidth: 1080, margin: "0 auto", display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div className="sg" style={{ fontSize: 28, fontWeight: 700, letterSpacing: -0.5, display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: AMBER, display: "inline-block" }} />
              RoadPulse
            </div>
            <div style={{ color: "#B8B5AE", fontSize: 14, marginTop: 4, maxWidth: 480 }}>
              AI-assisted road damage detection &amp; civic reporting — spot it, log it, track it.
            </div>
          </div>
          <div style={{ display: "flex", gap: 24 }}>
            <Stat label="Logged" value={reports.length} />
            <Stat label="High severity" value={highCount} accent={RED} />
          </div>
        </div>
      </div>
      <div className="lane-divider" />

      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "32px 32px 64px" }}>
        {/* Detect & Report panel */}
        <section style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: 28, marginBottom: 48 }}>
          <div>
            <h2 className="sg" style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>1. Capture a road image</h2>
            <div
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); }}
              style={{
                border: `1.5px dashed ${imgEl ? "transparent" : "#c9c4b6"}`,
                borderRadius: 4, minHeight: 260, display: "flex", alignItems: "center", justifyContent: "center",
                background: imgEl ? ASPHALT : "#EFEBE1", overflow: "hidden", position: "relative",
              }}
            >
              {!imgEl && (
                <div style={{ textAlign: "center", color: ROAD_GRAY }}>
                  <Upload size={28} style={{ marginBottom: 8 }} />
                  <div style={{ fontSize: 14, fontWeight: 500 }}>Drop a photo or click to upload</div>
                  <div style={{ fontSize: 12, marginTop: 4, color: "#8b8778" }}>JPG or PNG of a road surface</div>
                </div>
              )}
              {imgEl && <canvas ref={canvasRef} style={{ width: "100%", height: "auto", display: analyzing ? "none" : "block" }} />}
              {imgEl && analyzing && (
                <div style={{ color: AMBER, fontSize: 13, fontWeight: 600, letterSpacing: 0.3 }}>Analyzing surface…</div>
              )}
            </div>
            <input ref={fileInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => handleFile(e.target.files[0])} />

            {result && !analyzing && (
              <div style={{ marginTop: 12, fontSize: 13, color: ROAD_GRAY, display: "flex", alignItems: "center", gap: 8 }}>
                {result.detected ? (
                  <><AlertTriangle size={15} color={RED} /> Anomaly detected — {Math.round(result.confidence * 100)}% confidence. Review and adjust below.</>
                ) : (
                  <><CheckCircle2 size={15} color={GREEN} /> No strong anomaly found. You can still log an issue manually.</>
                )}
              </div>
            )}
          </div>

          <div>
            <h2 className="sg" style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>2. Confirm & log</h2>
            <div style={{ background: "white", border: "1px solid #e6e2d6", borderRadius: 4, padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
              <Field label="Category">
                <select value={category} onChange={(e) => setCategory(e.target.value)} style={selectStyle}>
                  {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                </select>
              </Field>
              <Field label="Severity">
                <div style={{ display: "flex", gap: 8 }}>
                  {SEVERITIES.map((s) => (
                    <button key={s} onClick={() => setSeverity(s)}
                      style={{
                        flex: 1, padding: "8px 0", borderRadius: 3, fontSize: 13, fontWeight: 600,
                        border: `1.5px solid ${severity === s ? SEVERITY_COLOR[s] : "#e6e2d6"}`,
                        background: severity === s ? SEVERITY_COLOR[s] : "white",
                        color: severity === s ? "white" : ROAD_GRAY,
                      }}>{s}</button>
                  ))}
                </div>
              </Field>
              <Field label="Location">
                <div style={{ display: "flex", gap: 6 }}>
                  <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Street / landmark or coordinates"
                    style={{ ...selectStyle, flex: 1 }} />
                  <button onClick={useMyLocation} title="Use my location"
                    style={{ border: "1px solid #e6e2d6", borderRadius: 3, background: "white", padding: "0 10px", display: "flex", alignItems: "center" }}>
                    <Navigation size={15} color={ROAD_GRAY} />
                  </button>
                </div>
              </Field>
              <Field label="Notes (optional)">
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
                  placeholder="Anything worth flagging for reviewers"
                  style={{ ...selectStyle, resize: "vertical" }} />
              </Field>
              <button onClick={submitReport} disabled={!imgEl}
                style={{
                  marginTop: 4, padding: "11px 0", borderRadius: 3, border: "none",
                  background: imgEl ? ASPHALT : "#d8d4c8", color: "white", fontWeight: 600, fontSize: 14,
                }}>
                Log this report
              </button>
              {saveErr && <div style={{ fontSize: 12, color: RED }}>{saveErr}</div>}
            </div>
          </div>
        </section>

        {/* Dashboard */}
        <section>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
            <h2 className="sg" style={{ fontSize: 18, fontWeight: 600 }}>Reported issues</h2>
            <button onClick={resetDemo} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: ROAD_GRAY, background: "none", border: "none" }}>
              <RotateCcw size={13} /> Reset demo data
            </button>
          </div>

          {reports.length === 0 && !loading ? (
            <div style={{ background: "white", border: "1px dashed #e6e2d6", borderRadius: 4, padding: 40, textAlign: "center", color: "#8b8778", fontSize: 14 }}>
              No reports logged yet. Upload a road photo above to create your first one.
            </div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 24 }}>
                <ChartCard title="By category">
                  <ResponsiveContainer width="100%" height={180}>
                    <BarChart data={catCounts} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                      <CartesianGrid stroke="#eee" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 11, fill: ROAD_GRAY }} axisLine={{ stroke: "#e6e2d6" }} tickLine={false} />
                      <YAxis tick={{ fontSize: 11, fill: ROAD_GRAY }} axisLine={false} tickLine={false} allowDecimals={false} />
                      <Tooltip />
                      <Bar dataKey="value" fill={AMBER} radius={[2, 2, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </ChartCard>
                <ChartCard title="By severity">
                  <ResponsiveContainer width="100%" height={180}>
                    <PieChart>
                      <Pie data={sevCounts} dataKey="value" nameKey="name" innerRadius={45} outerRadius={70} paddingAngle={2}>
                        {sevCounts.map((d, i) => <Cell key={i} fill={SEVERITY_COLOR[d.name]} />)}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                </ChartCard>
              </div>

              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                <select value={filterCat} onChange={(e) => setFilterCat(e.target.value)} style={{ ...selectStyle, width: "auto", fontSize: 12, padding: "6px 8px" }}>
                  <option>All</option>
                  {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                </select>
                <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} style={{ ...selectStyle, width: "auto", fontSize: 12, padding: "6px 8px" }}>
                  <option>All</option>
                  {STATUSES.map((s) => <option key={s}>{s}</option>)}
                </select>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {filtered.map((r) => {
                  const Icon = STATUS_ICON[r.status];
                  return (
                    <div key={r.id} style={{ background: "white", border: "1px solid #e6e2d6", borderRadius: 4, padding: "12px 16px", display: "flex", alignItems: "center", gap: 14 }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: SEVERITY_COLOR[r.severity], flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 600 }}>{r.category}</div>
                        <div style={{ fontSize: 12, color: ROAD_GRAY, display: "flex", alignItems: "center", gap: 4, marginTop: 2 }}>
                          <MapPin size={11} /> {r.location}
                          {r.confidence != null && <span style={{ marginLeft: 8 }}>· {r.confidence}% confidence</span>}
                        </div>
                        {r.notes && <div style={{ fontSize: 12, color: "#8b8778", marginTop: 3 }}>{r.notes}</div>}
                      </div>
                      <button onClick={() => cycleStatus(r.id)}
                        style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 600, border: "1px solid #e6e2d6", borderRadius: 3, padding: "5px 10px", background: "#fafaf7", color: ASPHALT }}>
                        <Icon size={12} /> {r.status}
                      </button>
                      <button onClick={() => deleteReport(r.id)} style={{ background: "none", border: "none", color: "#b8b5ae" }}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div>
      <div className="sg" style={{ fontSize: 26, fontWeight: 700, color: accent || "white" }}>{value}</div>
      <div style={{ fontSize: 11, color: "#B8B5AE", textTransform: "none" }}>{label}</div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: ROAD_GRAY, marginBottom: 5 }}>{label}</div>
      {children}
    </div>
  );
}

function ChartCard({ title, children }) {
  return (
    <div style={{ background: "white", border: "1px solid #e6e2d6", borderRadius: 4, padding: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: ROAD_GRAY, marginBottom: 4 }}>{title}</div>
      {children}
    </div>
  );
}

const selectStyle = {
  width: "100%", padding: "9px 10px", borderRadius: 3, border: "1px solid #e6e2d6",
  fontSize: 13, background: "white", color: ASPHALT, outline: "none",
};
