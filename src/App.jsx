import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import * as mammoth from "mammoth";

// ═══════════════════════════════════════════════
// CONFIG & PERSISTENCE
// ═══════════════════════════════════════════════

const DEFAULT_CONFIG = {
  apiMode: "live",
  workerUrl: "https://subtitle.ttimes.workers.dev",
};

function loadConfig() {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(localStorage.getItem("se_cfg") || "{}") }; }
  catch { return { ...DEFAULT_CONFIG }; }
}
function saveConfig(c) { localStorage.setItem("se_cfg", JSON.stringify(c)); }

// ═══════════════════════════════════════════════
// API CLIENT
// ═══════════════════════════════════════════════

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function apiCall(endpoint, body, config, retries = 4) {
  if (config.apiMode === "mock") return null;
  const url = `${config.workerUrl}/${endpoint}`;

  for (let i = 0; i < retries; i++) {
    let r;
    try {
      r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (netErr) {
      if (i < retries - 1) {
        const waitTime = (i + 1) * 15000;
        console.warn(`🌐 네트워크 에러 (${endpoint}): ${netErr.message}. ${waitTime/1000}초 후 재시도 (${i+1}/${retries})`);
        await delay(waitTime);
        continue;
      }
      throw new Error(`네트워크 연결 실패 (${endpoint}). Worker 서버 상태를 확인해주세요.\n원인: ${netErr.message}`);
    }

    let d;
    try {
      d = await r.json();
    } catch (parseErr) {
      if (i < retries - 1) {
        const waitTime = (i + 1) * 15000;
        await delay(waitTime);
        continue;
      }
      throw new Error(`Worker 서버 오류 (${endpoint}, HTTP ${r.status}).`);
    }

    if (d.success) return d;

    if (r.status === 429 || d.status === 429 || (d.error && d.error.includes("Rate limited"))) {
      const waitTime = (i + 1) * 15000;
      console.warn(`⏳ API 한도 초과! ${waitTime/1000}초 후 재시도 (${i+1}/${retries})`);
      await delay(waitTime);
      continue;
    }

    throw new Error(d.error || `${endpoint} failed`);
  }
  throw new Error("API 요청 한도 초과. 잠시 후 다시 시도해주세요.");
}

async function apiSaveSession(sessionData, config) {
  const base = config.workerUrl || "";
  if (!base) throw new Error("Worker URL이 설정되지 않았습니다.");
  const r = await fetch(`${base}/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sessionData),
  });
  const d = await r.json();
  if (!d.success) throw new Error(d.error || "저장 실패");
  return d.id;
}

async function apiLoadSession(id, config) {
  const base = config.workerUrl || "";
  if (!base) throw new Error("Worker URL이 설정되지 않았습니다.");
  const r = await fetch(`${base}/load/${id}`);
  if (!r.ok) { const d = await r.json(); throw new Error(d.error || "불러오기 실패"); }
  return r.json();
}

// Step 0
async function apiAnalyze(fullText, cfg) {
  if (cfg.apiMode === "mock") {
    await delay(700);
    return {
      overview: { topic: "인터뷰 주제 (Mock 분석)", keywords: ["프롬프트","클로드","앤트로픽"] },
      speakers: [], domain_terms: [],
      term_corrections: [
        {wrong:"엔트로피",correct:"앤트로픽",confidence:"high"},
        {wrong:"프롬보트",correct:"프롬프트",confidence:"high"},
      ],
      genre: { primary: "설명형", secondary: null, transitions: [] },
      tech_difficulty: "보통",
      audience_level: "관심 있는 비전문가",
      editorial_summary: {
        one_liner: "앤트로픽의 클로드 AI와 프롬프트 엔지니어링의 미래에 대한 심층 인터뷰",
        key_points: [
          "클로드의 컨텍스트 윈도우 확장이 실무에 미치는 영향",
          "프롬프트 엔지니어링이 개발자 워크플로우를 어떻게 바꾸고 있는지",
        ],
        notable_quotes: [
          { speaker: "게스트", quote: "프롬프트 엔지니어링은 결국 사라질 직업이 아니라, 모든 직업에 녹아들 기술입니다" },
        ],
        editor_notes: "AI/기술 전문용어가 밀집된 구간이 있어 B2 자막 주의 필요."
      },
    };
  }
  const payload = { full_text: fullText };
  const d = await apiCall("analyze", payload, cfg);
  return d.analysis;
}

// 2단계 — Draft Agent
async function apiHighlightsDraft(blocks, analysis, cfg, chunk_index, total_chunks) {
  if (cfg.apiMode === "mock") {
    await delay(800);
    const hl = [];
    blocks.filter(b => b.text.length > 80).forEach((b, i) => {
      if (i % 3 === 0) hl.push({
        block_index: b.index, speaker: b.speaker,
        source_text: b.text.substring(0, 50) + "...",
        subtitle: b.text.replace(/\s+/g," ").substring(0, 35) + "…",
        type: ["A1","B1","B2","C1","D1","E1"][i % 6],
        type_name: ["핵심 논지 압축","등호 정의형","용어 설명형","질문 프레이밍형","비교 평가형","기능 헤드라인"][i % 6],
        reason: "핵심 구간 (Draft)",
        placement_hint: null, sequence_id: null,
      });
    });
    return { highlights: hl.slice(0, 40) };
  }
  const body = { mode: "draft", blocks, analysis };
  if (chunk_index !== undefined) { body.chunk_index = chunk_index; body.total_chunks = total_chunks; }
  const d = await apiCall("highlights", body, cfg);
  return d.result;
}

// 2단계 — Editor Agent
async function apiHighlightsEdit(blocks, analysis, draftHighlights, cfg, chunk_index, total_chunks) {
  if (cfg.apiMode === "mock") {
    await delay(600);
    const kept = draftHighlights.filter((_, i) => i % 3 !== 2);
    const removed = draftHighlights.filter((_, i) => i % 3 === 2).map(h => ({
      block_index: h.block_index, reason: "밀도 조정으로 제거 (Mock)"
    }));
    return {
      highlights: kept, removed,
      stats: {
        draft_count: draftHighlights.length,
        final_count: kept.length,
        removal_rate: `${Math.round((1 - kept.length / draftHighlights.length) * 100)}%`,
      },
    };
  }
  const body = { mode: "edit", blocks, analysis, draft_highlights: draftHighlights };
  if (chunk_index !== undefined) { body.chunk_index = chunk_index; body.total_chunks = total_chunks; }
  const d = await apiCall("highlights", body, cfg);
  return d.result;
}

// ═══════════════════════════════════════════════
// BLOCK PARSING
// ═══════════════════════════════════════════════

function parseBlocks(text) {
  const lines = text.split("\n"), blocks = [];
  let cur = null;
  const hdr = /^(.+?)\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*$/;
  const hdrInline = /^([가-힣a-zA-Z\s]{2,15}?)\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*(.+)$/;
  const hdrNumbered = /^((?:참석자|화자|Speaker)\s*\d+)\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*(.*)$/;
  for (const line of lines) {
    const t = line.trim();
    if (!t) { if (cur) { blocks.push(cur); cur = null; } continue; }
    const m3 = t.match(hdrNumbered);
    if (m3) {
      if (cur) blocks.push(cur);
      const bodyText = (m3[3] || "").trim();
      cur = { index: blocks.length, speaker: m3[1].trim(), timestamp: m3[2], text: bodyText, lines: bodyText ? [bodyText] : [] };
      continue;
    }
    const m = t.match(hdr);
    if (m) {
      if (cur) blocks.push(cur);
      cur = { index: blocks.length, speaker: m[1], timestamp: m[2], text: "", lines: [] };
    } else {
      const m2 = t.match(hdrInline);
      if (m2) {
        if (cur) blocks.push(cur);
        const bodyText = m2[3].trim();
        cur = { index: blocks.length, speaker: m2[1].trim(), timestamp: m2[2], text: bodyText, lines: [bodyText] };
      } else if (cur) {
        cur.text += (cur.text ? "\n" : "") + t; cur.lines.push(t);
      } else {
        cur = { index: blocks.length, speaker: "—", timestamp: "", text: t, lines: [t] };
      }
    }
  }
  if (cur) blocks.push(cur);
  return blocks.map((b, i) => ({ ...b, index: i }));
}

// ═══════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════

const DARK_THEME = {
  bg:"#0F1117",sf:"#181B25",bd:"#2A2E3B",
  tx:"#E4E6ED",txM:"#8B8FA3",txD:"#5C6078",
  ac:"#4A6CF7",acS:"rgba(74,108,247,0.12)",
  fBg:"rgba(251,191,36,0.18)",fTx:"#FBBF24",
  tBg:"rgba(239,68,68,0.15)",tTx:"#EF4444",
  cBg:"rgba(34,197,94,0.15)",cTx:"#22C55E",
  hBd:"#A855F7",hBg:"rgba(168,85,247,0.12)",
  vBg:"rgba(59,130,246,0.1)",
  ok:"#22C55E",wn:"#FBBF24",
  overlay:"rgba(0,0,0,0.6)",glass:"rgba(255,255,255,0.04)",
  glass2:"rgba(255,255,255,0.06)",glass3:"rgba(255,255,255,0.08)",glassHover:"rgba(255,255,255,0.03)",
  inputBg:"rgba(0,0,0,0.3)",
  btnTx:"#fff",
  linkTx:"#3B82F6",
  sessionHover:"rgba(255,255,255,0.02)",
  panelBg:"rgba(0,0,0,0.12)",
  acHover:"rgba(74,108,247,0.08)",acTag:"rgba(74,108,247,0.15)",acFade:"rgba(74,108,247,0.4)",
  acBtnAlt:"rgba(74,108,247,0.2)",acPill:"rgba(74,108,247,0.12)",
  hActive:"rgba(168,85,247,0.18)",hLight:"rgba(168,85,247,0.08)",hFaint:"rgba(168,85,247,0.06)",
  hShadow:"rgba(168,85,247,0.3)",hGlow:"rgba(168,85,247,0.1)",
  tFaint:"rgba(239,68,68,0.06)",tBorder:"rgba(239,68,68,0.2)",tCard:"rgba(239,68,68,0.05)",tMid:"rgba(239,68,68,0.4)",tBanner:"rgba(239,68,68,0.1)",
  cFaint:"rgba(34,197,94,0.04)",cLight:"rgba(34,197,94,0.06)",cMid:"rgba(34,197,94,0.08)",cBorder:"rgba(34,197,94,0.2)",cStrong:"rgba(34,197,94,0.3)",
  vMid:"rgba(59,130,246,0.12)",
  wnTag:"rgba(245,158,11,0.15)",
  gradShare:`linear-gradient(135deg,#22C55E,#16A34A)`,gradAc:`linear-gradient(135deg,#4A6CF7,#7C3AED)`,
};
const LIGHT_THEME = {
  bg:"#F5F6FA",sf:"#FFFFFF",bd:"#D8DBE5",
  tx:"#1A1D2E",txM:"#5C6078",txD:"#8B8FA3",
  ac:"#3B5CE4",acS:"rgba(59,92,228,0.10)",
  fBg:"rgba(217,160,0,0.14)",fTx:"#B8860B",
  tBg:"rgba(220,38,38,0.10)",tTx:"#DC2626",
  cBg:"rgba(22,163,74,0.10)",cTx:"#16A34A",
  hBd:"#9333EA",hBg:"rgba(147,51,234,0.10)",
  vBg:"rgba(37,99,235,0.08)",
  ok:"#16A34A",wn:"#D97706",
  overlay:"rgba(0,0,0,0.35)",glass:"rgba(0,0,0,0.03)",
  glass2:"rgba(0,0,0,0.05)",glass3:"rgba(0,0,0,0.06)",glassHover:"rgba(0,0,0,0.02)",
  inputBg:"rgba(0,0,0,0.04)",
  btnTx:"#fff",
  linkTx:"#2563EB",
  sessionHover:"rgba(0,0,0,0.02)",
  panelBg:"rgba(0,0,0,0.03)",
  acHover:"rgba(59,92,228,0.06)",acTag:"rgba(59,92,228,0.12)",acFade:"rgba(59,92,228,0.3)",
  acBtnAlt:"rgba(59,92,228,0.15)",acPill:"rgba(59,92,228,0.10)",
  hActive:"rgba(147,51,234,0.12)",hLight:"rgba(147,51,234,0.06)",hFaint:"rgba(147,51,234,0.04)",
  hShadow:"rgba(147,51,234,0.2)",hGlow:"rgba(147,51,234,0.06)",
  tFaint:"rgba(220,38,38,0.04)",tBorder:"rgba(220,38,38,0.15)",tCard:"rgba(220,38,38,0.03)",tMid:"rgba(220,38,38,0.3)",tBanner:"rgba(220,38,38,0.08)",
  cFaint:"rgba(22,163,74,0.03)",cLight:"rgba(22,163,74,0.04)",cMid:"rgba(22,163,74,0.06)",cBorder:"rgba(22,163,74,0.15)",cStrong:"rgba(22,163,74,0.2)",
  vMid:"rgba(37,99,235,0.10)",
  wnTag:"rgba(217,119,6,0.12)",
  gradShare:`linear-gradient(135deg,#16A34A,#15803D)`,gradAc:`linear-gradient(135deg,#3B5CE4,#6D28D9)`,
};

const _savedTheme = (() => { try { return localStorage.getItem("se_theme") || "dark"; } catch { return "dark"; } })();
const C = { ...(_savedTheme === "light" ? LIGHT_THEME : DARK_THEME) };
function applyTheme(mode) {
  Object.assign(C, mode === "light" ? LIGHT_THEME : DARK_THEME);
  try { localStorage.setItem("se_theme", mode); } catch {}
}
const FN = "'Pretendard','Noto Sans KR',-apple-system,sans-serif";

const MARKER_COLORS_DARK = {
  yellow: { bg: "rgba(251,191,36,0.3)", border: "#FBBF24", label: "노랑" },
  blue:   { bg: "rgba(59,130,246,0.3)", border: "#3B82F6", label: "파랑" },
  green:  { bg: "rgba(34,197,94,0.3)",  border: "#22C55E", label: "초록" },
  red:    { bg: "rgba(239,68,68,0.3)",  border: "#EF4444", label: "빨강" },
};
const MARKER_COLORS_LIGHT = {
  yellow: { bg: "rgba(251,191,36,0.22)", border: "#D97706", label: "노랑" },
  blue:   { bg: "rgba(59,130,246,0.22)", border: "#2563EB", label: "파랑" },
  green:  { bg: "rgba(34,197,94,0.22)",  border: "#16A34A", label: "초록" },
  red:    { bg: "rgba(239,68,68,0.22)",  border: "#DC2626", label: "빨강" },
};
let MARKER_COLORS = _savedTheme === "light" ? MARKER_COLORS_LIGHT : MARKER_COLORS_DARK;

// ═══════════════════════════════════════════════
// SMALL COMPONENTS
// ═══════════════════════════════════════════════

function Badge({ name }) {
  const h = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  const isLight = C.bg[1] > "E";
  return <span style={{ fontSize:11,fontWeight:700,padding:"2px 7px",borderRadius:4,
    background:`hsla(${h},55%,50%,${isLight?0.12:0.15})`,color:`hsl(${h},${isLight?"50%,38%":"55%,65%"})`,marginRight:5 }}>{name}</span>;
}

function Progress({ pct, label }) {
  return <div style={{margin:"16px 0"}}>
    <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
      <span style={{fontSize:13,color:C.txM}}>{label}</span>
      <span style={{fontSize:13,color:C.ac,fontWeight:600}}>{pct}%</span>
    </div>
    <div style={{height:4,background:C.bd,borderRadius:2,overflow:"hidden"}}>
      <div style={{height:"100%",background:`linear-gradient(90deg,${C.ac},#7C3AED)`,
        width:`${pct}%`,borderRadius:2,transition:"width 0.4s"}}/>
    </div>
  </div>;
}

function TypeBadge({ type }) {
  if (!type) return null;
  const colors = {
    A: { bg: C.fBg, tx: C.fTx },
    B: { bg: C.vBg, tx: C.linkTx },
    C: { bg: C.cBg, tx: C.cTx },
    D: { bg: C.tBg, tx: C.tTx },
    E: { bg: C.hBg, tx: C.hBd },
  };
  const cat = type.charAt(0);
  const c = colors[cat] || { bg: C.glass3, tx: C.txM };
  return <span style={{fontSize:10,fontWeight:700,padding:"2px 6px",borderRadius:4,
    background:c.bg,color:c.tx,letterSpacing:"0.03em"}}>{type}</span>;
}

// ── 형광펜 텍스트 렌더링 ──
function MarkedText({ text, blockIdx, hlMarkers, matchingMode, onMarkerAdd }) {
  const textRef = useRef(null);

  const markers = [];
  for (const [key, m] of Object.entries(hlMarkers || {})) {
    if (!m.ranges) continue;
    for (const r of m.ranges) {
      if (r.blockIdx === blockIdx) {
        markers.push({ s: r.s, e: r.e, color: m.color, key });
      }
    }
  }
  markers.sort((a, b) => a.s - b.s);

  const segs = [];
  let cursor = 0;
  for (const m of markers) {
    const s = Math.max(m.s, cursor);
    const e = Math.min(m.e, text.length);
    if (s >= e) continue;
    if (s > cursor) segs.push({ text: text.substring(cursor, s), color: null });
    segs.push({ text: text.substring(s, e), color: m.color, key: m.key });
    cursor = e;
  }
  if (cursor < text.length) segs.push({ text: text.substring(cursor), color: null });
  if (segs.length === 0) segs.push({ text, color: null });

  const isMatching = matchingMode && matchingMode.blockIdx === blockIdx;

  const handleMouseUp = useCallback(() => {
    if (!matchingMode) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !textRef.current) return;
    const container = textRef.current;
    if (!container.contains(sel.anchorNode) || !container.contains(sel.focusNode)) return;
    const selectedText = sel.toString();
    if (!selectedText.trim()) return;

    const range = sel.getRangeAt(0);
    let startOffset = 0;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
    let node;
    let found = false;
    while ((node = walker.nextNode())) {
      if (node === range.startContainer) {
        startOffset += range.startOffset;
        found = true;
        break;
      }
      startOffset += node.textContent.length;
    }
    if (!found) return;
    const endOffset = startOffset + selectedText.length;
    if (startOffset < 0 || endOffset > text.length || startOffset >= endOffset) return;

    onMarkerAdd(matchingMode.key, matchingMode.color, blockIdx, startOffset, endOffset);
    sel.removeAllRanges();
  }, [matchingMode, blockIdx, onMarkerAdd, text]);

  return <div ref={textRef}
    onMouseUp={handleMouseUp}
    style={{fontSize:14,lineHeight:1.8,color:C.tx,wordBreak:"keep-all",whiteSpace:"pre-wrap",
      cursor:isMatching?"crosshair":"inherit",transition:"all 0.15s"}}>
    {segs.map((s, i) => s.color
      ? <span key={i} style={{background:MARKER_COLORS[s.color]?.bg,borderRadius:3,padding:"1px 0",
          borderBottom:`2px solid ${MARKER_COLORS[s.color]?.border}`}}>{s.text}</span>
      : <span key={i}>{s.text}</span>
    )}
  </div>;
}

// ═══════════════════════════════════════════════
// GUIDE CARD
// ═══════════════════════════════════════════════

function GuideCard({ item, active, onClick, blocks, verdict, onVerdict, editedText, onEdit, onRelocate }) {
  const bc = C.hBd, bg = C.hBg;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const [relocating, setRelocating] = useState(false);
  const [relocTarget, setRelocTarget] = useState(item.block_index);

  const tsOf = (idx) => blocks?.find(b => b.index === idx)?.timestamp || `#${idx}`;
  const timeLabel = tsOf(item.block_index);

  const verdictOptions = [
    { key: "use", label: "사용", color: C.cTx, bg: C.cBg },
    { key: "discard", label: "폐기", color: C.tTx, bg: C.tBg },
  ];
  const currentVerdict = verdict || null;
  const hasEdit = editedText && editedText !== item.subtitle;
  const isB2 = item.type === "B2";

  const borderColor = currentVerdict === "use" ? C.cTx
    : currentVerdict === "discard" ? C.tMid
    : active ? bc : C.bd;
  const cardBg = currentVerdict === "discard" ? C.tCard : active ? bg : C.sf;
  const cardOpacity = currentVerdict === "discard" ? 0.6 : 1;

  const startEdit = (e) => { e.stopPropagation(); setDraft(editedText || item.subtitle); setEditing(true); };
  const saveEdit = (e) => {
    e.stopPropagation();
    const trimmed = draft.trim();
    if (trimmed && trimmed !== item.subtitle) onEdit(item, trimmed);
    else if (trimmed === item.subtitle) onEdit(item, null);
    setEditing(false);
  };

  const handleVerdictClick = (e, vKey) => {
    e.stopPropagation();
    if (vKey === "use" && currentVerdict !== "use") {
      setRelocTarget(item.block_index);
      setRelocating(true);
      onVerdict(item, "use");
    } else if (vKey === "use" && currentVerdict === "use") {
      setRelocating(false);
      onVerdict(item, null);
    } else {
      setRelocating(false);
      onVerdict(item, currentVerdict === vKey ? null : vKey);
    }
  };

  const confirmRelocate = (e) => {
    e.stopPropagation();
    const targetIdx = parseInt(relocTarget);
    if (!isNaN(targetIdx) && onRelocate && targetIdx !== item.block_index) onRelocate(item, targetIdx);
    setRelocating(false);
  };

  return <div onClick={() => onClick(item)} style={{border:`1px solid ${borderColor}`,borderRadius:10,
    padding:"10px 12px",marginBottom:8,background:cardBg,cursor:"pointer",transition:"all 0.12s",
    boxShadow:active?`0 0 0 2px ${bc}44`:"none",opacity:cardOpacity}}>
    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
      <span style={{fontSize:13}}>{item._manual ? "✏️" : "💬"}</span>
      <Badge name={item.speaker||"—"}/>
      <span style={{fontSize:11,color:active?bc:C.txD,fontFamily:"monospace",fontWeight:active?700:400}}>⏱ {timeLabel}</span>
      <TypeBadge type={item.type}/>
      {item._manual && <span style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:3,background:C.cBg,color:C.cTx}}>수동</span>}
      <span style={{fontSize:10,color:C.txD,fontFamily:"monospace",marginLeft:"auto"}}>#{item.block_index}</span>
    </div>

    {!editing ? (
      <div>
        <div style={{display:"flex",alignItems:"flex-start",gap:6}}>
          <div style={{flex:1}}>
            {isB2 && <div style={{marginBottom:3}}><span style={{fontSize:11,fontWeight:700,color:C.linkTx,background:C.vMid,padding:"1px 6px",borderRadius:3}}>용어설명</span></div>}
            <div style={{fontSize:14,fontWeight:500,lineHeight:1.5,whiteSpace:"pre-line",
              color:hasEdit?(currentVerdict==="discard"?C.txD:C.tTx):currentVerdict==="discard"?C.txD:C.tx,
              textDecoration:(hasEdit||currentVerdict==="discard")?"line-through":"none"}}>
              {item.subtitle}
            </div>
          </div>
          <button onClick={e=>{e.stopPropagation();const t=hasEdit?editedText:item.subtitle;navigator.clipboard.writeText(t);setCopied(true);setTimeout(()=>setCopied(false),1500)}}
            style={{fontSize:10,fontWeight:600,padding:"2px 6px",borderRadius:4,
              border:`1px solid ${copied?C.cTx:C.bd}`,background:copied?C.cBg:C.glass,
              color:copied?C.cTx:C.txM,cursor:"pointer",flexShrink:0,marginTop:2,transition:"all 0.15s",minWidth:28}}>
            {copied?"✓":"복사"}</button>
          <button onClick={startEdit} style={{fontSize:10,fontWeight:600,padding:"2px 6px",borderRadius:4,
            border:`1px solid ${C.bd}`,background:C.glass,color:C.txM,cursor:"pointer",flexShrink:0,marginTop:2}}>수정</button>
        </div>
        {hasEdit && (
          <div style={{marginTop:4}}>
            <div style={{display:"flex",alignItems:"flex-start",gap:6}}>
              <div style={{flex:1,fontSize:14,fontWeight:600,lineHeight:1.5,color:C.cTx,whiteSpace:"pre-line"}}>{editedText}</div>
              <button onClick={e=>{e.stopPropagation();onEdit(item, null)}}
                style={{fontSize:10,fontWeight:600,padding:"2px 6px",borderRadius:4,border:`1px solid ${C.bd}`,background:C.glass,color:C.txM,cursor:"pointer",flexShrink:0,marginTop:2}}
                title="수정 취소">↩ undo</button>
            </div>
          </div>
        )}
      </div>
    ) : (
      <div onClick={e=>e.stopPropagation()} style={{marginTop:2}}>
        <textarea value={draft} onChange={e=>setDraft(e.target.value)} rows={2} autoFocus
          style={{width:"100%",padding:"6px 8px",borderRadius:6,border:`1px solid ${C.ac}`,
            background:C.inputBg,color:C.tx,fontSize:13,fontFamily:FN,lineHeight:1.5,resize:"vertical",outline:"none"}}
          onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();saveEdit(e);}if(e.key==="Escape")setEditing(false);}}/>
        <div style={{display:"flex",gap:4,marginTop:4,justifyContent:"flex-end"}}>
          <button onClick={()=>setEditing(false)} style={{fontSize:11,padding:"3px 10px",borderRadius:4,
            border:`1px solid ${C.bd}`,background:"transparent",color:C.txM,cursor:"pointer"}}>취소</button>
          <button onClick={saveEdit} style={{fontSize:11,padding:"3px 10px",borderRadius:4,
            border:"none",background:C.ac,color:C.btnTx,fontWeight:600,cursor:"pointer"}}>저장</button>
        </div>
      </div>
    )}

    {item.type_name && <div style={{fontSize:11,color:C.txD,marginTop:2}}>{item.type_name}</div>}
    {open && <div style={{background:C.glass,borderRadius:8,padding:10,marginTop:8,border:`1px solid ${C.bd}`}}>
      <div style={{fontSize:12,color:C.txM,marginBottom:4}}><b>사유:</b> {item.reason}</div>
      {item.source_text && <div style={{fontSize:12,color:C.txD}}><b>원문:</b> {item.source_text}</div>}
      {item.placement_hint && <div style={{fontSize:12,color:C.txD,marginTop:4}}><b>배치:</b> {item.placement_hint}</div>}
    </div>}
    <div style={{display:"flex",alignItems:"center",gap:4,marginTop:6}}>
      <button onClick={e=>{e.stopPropagation();setOpen(!open)}} style={{fontSize:11,color:C.ac,background:"none",border:"none",cursor:"pointer",padding:"2px 0"}}>
        {open?"접기 ▲":"상세 ▼"}</button>
      <div style={{marginLeft:"auto",display:"flex",gap:3}}>
        {verdictOptions.map(v => (
          <button key={v.key} onClick={e=>handleVerdictClick(e, v.key)}
            style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:4,cursor:"pointer",transition:"all 0.1s",
              border:`1px solid ${currentVerdict===v.key?v.color:"transparent"}`,
              background:currentVerdict===v.key?v.bg:C.glass,
              color:currentVerdict===v.key?v.color:C.txD}}>
            {v.label}
          </button>
        ))}
      </div>
    </div>
    {relocating && currentVerdict === "use" && (
      <div onClick={e=>e.stopPropagation()} style={{marginTop:8,padding:"8px 10px",borderRadius:8,
        background:C.cMid,border:`1px solid ${C.cBorder}`}}>
        <div style={{fontSize:11,color:C.cTx,fontWeight:600,marginBottom:6}}>📍 배치 위치 선택</div>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <span style={{fontSize:11,color:C.txM}}>블록 #</span>
          <select value={relocTarget} onChange={e=>setRelocTarget(e.target.value)}
            style={{padding:"4px 8px",borderRadius:5,border:`1px solid ${C.bd}`,
              background:C.inputBg,color:C.tx,fontSize:12,outline:"none",flex:1,maxWidth:200}}>
            {blocks.map(b => (
              <option key={b.index} value={b.index}>#{b.index} {b.speaker} {b.timestamp}</option>
            ))}
          </select>
          <button onClick={confirmRelocate}
            style={{fontSize:11,fontWeight:600,padding:"4px 10px",borderRadius:5,border:"none",
              background:C.cTx,color:C.btnTx,cursor:"pointer"}}>확인</button>
          <button onClick={e=>{e.stopPropagation();setRelocating(false)}}
            style={{fontSize:11,padding:"4px 8px",borderRadius:5,border:`1px solid ${C.bd}`,
              background:"transparent",color:C.txM,cursor:"pointer"}}>닫기</button>
        </div>
        <div style={{fontSize:10,color:C.txD,marginTop:4}}>현재: #{item.block_index} · 이 자막이 선택한 블록 아래에 표시됩니다</div>
      </div>
    )}
  </div>;
}

// ═══════════════════════════════════════════════
// MODALS
// ═══════════════════════════════════════════════

function ShareModal({ shareUrl, onClose }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(shareUrl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };
  return <div style={{position:"fixed",inset:0,background:C.overlay,zIndex:200,
    display:"flex",alignItems:"center",justifyContent:"center"}} onClick={onClose}>
    <div onClick={e=>e.stopPropagation()} style={{background:C.sf,borderRadius:16,padding:28,width:480,border:`1px solid ${C.bd}`}}>
      <div style={{fontSize:17,fontWeight:700,color:C.tx,marginBottom:6}}>🔗 공유 링크 생성 완료</div>
      <div style={{fontSize:13,color:C.txM,marginBottom:16}}>아래 링크를 편집자에게 전달하세요. 30일간 유효합니다.</div>
      <div style={{display:"flex",gap:8,marginBottom:20}}>
        <input readOnly value={shareUrl}
          style={{flex:1,padding:"9px 12px",borderRadius:8,border:`1px solid ${C.bd}`,
            background:C.inputBg,color:C.tx,fontSize:12,fontFamily:"monospace",outline:"none"}}
          onFocus={e=>e.target.select()}/>
        <button onClick={copy} style={{padding:"9px 16px",borderRadius:8,border:"none",
          background:copied?C.ok:C.ac,color:C.btnTx,fontSize:13,fontWeight:600,cursor:"pointer",
          minWidth:72,transition:"background 0.2s"}}>
          {copied?"✓ 복사됨":"복사"}</button>
      </div>
      <div style={{display:"flex",justifyContent:"flex-end"}}>
        <button onClick={onClose} style={{padding:"8px 20px",borderRadius:6,border:`1px solid ${C.bd}`,
          background:"transparent",color:C.txM,fontSize:13,cursor:"pointer"}}>닫기</button>
      </div>
    </div>
  </div>;
}

function SessionListModal({ config, onLoad, onClose }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(null);

  useEffect(() => {
    if (!config.workerUrl || config.apiMode === "mock") { setLoading(false); return; }
    fetch(`${config.workerUrl}/sessions`)
      .then(r => r.json())
      .then(d => { if (d.success) setSessions(d.sessions || []); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [config]);

  const handleDelete = async (id) => {
    if (!confirm("이 세션을 삭제할까요?")) return;
    setDeleting(id);
    try {
      await fetch(`${config.workerUrl}/sessions/delete`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      setSessions(prev => prev.filter(s => s.id !== id));
    } catch {}
    setDeleting(null);
  };

  const formatDate = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return `${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
  };

  return <div style={{position:"fixed",inset:0,background:C.overlay,zIndex:200,
    display:"flex",alignItems:"center",justifyContent:"center"}} onClick={onClose}>
    <div onClick={e=>e.stopPropagation()} style={{background:C.sf,borderRadius:16,padding:28,
      width:560,maxHeight:"80vh",display:"flex",flexDirection:"column",border:`1px solid ${C.bd}`}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div style={{fontSize:17,fontWeight:700,color:C.tx}}>📋 작업 히스토리</div>
        <button onClick={onClose} style={{background:"none",border:"none",color:C.txD,cursor:"pointer",fontSize:18}}>✕</button>
      </div>
      <div style={{flex:1,overflowY:"auto"}}>
        {loading && <div style={{padding:32,textAlign:"center",color:C.txM}}>불러오는 중...</div>}
        {!loading && sessions.length === 0 && <div style={{padding:32,textAlign:"center",color:C.txD}}>저장된 세션이 없습니다</div>}
        {sessions.map(s => (
          <div key={s.id} onClick={()=>onLoad(s.id)}
            style={{padding:"12px 14px",borderRadius:8,border:`1px solid ${C.bd}`,marginBottom:8,
              cursor:"pointer",display:"flex",alignItems:"center",gap:12,transition:"background 0.1s",
              background:"transparent"}}
            onMouseEnter={e=>e.currentTarget.style.background=C.sessionHover}
            onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:13,fontWeight:600,color:C.tx,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{s.fn || "제목 없음"}</div>
              <div style={{fontSize:11,color:C.txD,marginTop:2}}>
                {formatDate(s.savedAt)} · {s.blockCount||0}블록 {s.hasGuide?"· ✅ 가이드":""}
              </div>
            </div>
            <button onClick={e=>{e.stopPropagation();handleDelete(s.id)}} disabled={deleting===s.id}
              style={{fontSize:11,padding:"4px 8px",borderRadius:4,border:`1px solid ${C.bd}`,
                background:"transparent",color:C.txD,cursor:"pointer",flexShrink:0}}>
              {deleting===s.id?"...":"삭제"}
            </button>
          </div>
        ))}
      </div>
    </div>
  </div>;
}

function SettingsModal({ config, onSave, onClose }) {
  const [m, setM] = useState(config.apiMode);
  const [u, setU] = useState(config.workerUrl);
  const save = () => { onSave({...config, apiMode:m, workerUrl:u.replace(/\/+$/,"")}); };
  const iS = {width:"100%",padding:"8px 10px",borderRadius:6,border:`1px solid ${C.bd}`,
    background:C.inputBg,color:C.tx,fontSize:13,fontFamily:FN,outline:"none"};
  return <div style={{position:"fixed",inset:0,background:C.overlay,zIndex:100,
    display:"flex",alignItems:"center",justifyContent:"center"}} onClick={onClose}>
    <div onClick={e=>e.stopPropagation()} style={{background:C.sf,borderRadius:16,padding:28,
      width:420,border:`1px solid ${C.bd}`}}>
      <div style={{fontSize:18,fontWeight:700,color:C.tx,marginBottom:20}}>⚙️ 설정</div>
      <div style={{marginBottom:16}}>
        <label style={{fontSize:12,color:C.txM,fontWeight:600,display:"block",marginBottom:6}}>API 모드</label>
        <div style={{display:"flex",gap:4}}>
          {[["mock","Mock (데모)"],["live","Live (GPT-5.1)"]].map(([v,l])=>
            <button key={v} onClick={()=>setM(v)} style={{flex:1,padding:8,borderRadius:6,
              border:`1px solid ${m===v?C.ac:C.bd}`,background:m===v?C.acS:"transparent",
              color:m===v?C.ac:C.txM,fontSize:13,fontWeight:600,cursor:"pointer"}}>{l}</button>)}
        </div>
      </div>
      {m==="live" && <div style={{marginBottom:16}}>
        <label style={{fontSize:12,color:C.txM,fontWeight:600,display:"block",marginBottom:6}}>Worker URL</label>
        <input value={u} onChange={e=>setU(e.target.value)} placeholder="https://subtitle.ttimes.workers.dev" style={iS}/>
      </div>}
      <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
        <button onClick={onClose} style={{padding:"8px 20px",borderRadius:6,border:`1px solid ${C.bd}`,
          background:"transparent",color:C.txM,fontSize:13,cursor:"pointer"}}>취소</button>
        <button onClick={save} style={{padding:"8px 20px",borderRadius:6,border:"none",
          background:C.ac,color:C.btnTx,fontSize:13,fontWeight:600,cursor:"pointer"}}>저장</button>
      </div>
    </div>
  </div>;
}

function EditorialSummaryPanel({ summary, collapsed, onToggle }) {
  if (!summary) return null;
  return <div style={{background:C.sf,borderRadius:12,border:`1px solid ${C.bd}`,overflow:"hidden",marginBottom:16}}>
    <div onClick={onToggle} style={{padding:"12px 14px",borderBottom:collapsed?"none":`1px solid ${C.bd}`,display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}}>
      <span style={{fontSize:13,fontWeight:700,color:C.tx}}>📋 콘텐츠 요약</span>
      <span style={{fontSize:11,color:C.txD}}>{collapsed?"▸ 펼치기":"▾ 접기"}</span>
    </div>
    {!collapsed && <div style={{padding:14}}>
      {summary.one_liner && <div style={{fontSize:15,fontWeight:600,color:C.tx,marginBottom:12,lineHeight:1.5}}>{summary.one_liner}</div>}
      {summary.key_points?.length > 0 && <div style={{marginBottom:12}}>
        <div style={{fontSize:11,fontWeight:700,color:C.txD,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:6}}>핵심 논점</div>
        {summary.key_points.map((p,i) => <div key={i} style={{fontSize:13,color:C.txM,lineHeight:1.6,marginBottom:6,display:"flex",gap:8,alignItems:"flex-start"}}>
          <span style={{flexShrink:0,fontSize:14,lineHeight:"1.5"}}>✅</span><span>{p}</span>
        </div>)}
      </div>}
      {summary.notable_quotes?.length > 0 && <div style={{marginBottom:12}}>
        <div style={{fontSize:11,fontWeight:700,color:C.txD,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:6}}>핵심 발언</div>
        {summary.notable_quotes.map((q,i) => <div key={i} style={{fontSize:13,color:C.tx,lineHeight:1.6,marginBottom:8,
          padding:"8px 12px",background:C.glass,borderRadius:8,borderLeft:`3px solid ${C.fTx}`}}>
          <div style={{fontSize:11,color:C.fTx,fontWeight:600,marginBottom:3}}>{q.speaker}</div>
          <div style={{fontStyle:"italic"}}>"{q.quote}"</div>
        </div>)}
      </div>}
      {summary.editor_notes && <div>
        <div style={{fontSize:11,fontWeight:700,color:C.txD,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:6}}>편집 참고</div>
        <div style={{fontSize:13,color:C.txM,lineHeight:1.6,padding:"6px 10px",background:C.glass,borderRadius:6}}>{summary.editor_notes}</div>
      </div>}
    </div>}
  </div>;
}

// ═══════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════

export default function App() {
  const [cfg, setCfg] = useState(loadConfig);
  const [theme, setTheme] = useState(_savedTheme);
  const toggleTheme = useCallback(() => {
    setTheme(prev => {
      const next = prev === "dark" ? "light" : "dark";
      applyTheme(next);
      MARKER_COLORS = next === "light" ? MARKER_COLORS_LIGHT : MARKER_COLORS_DARK;
      return next;
    });
  }, []);

  const [blocks, setBlocks] = useState([]);
  const [anal, setAnal] = useState(null);
  const [hl, setHl] = useState([]);
  const [hlStats, setHlStats] = useState(null);
  const [hlVerdicts, setHlVerdicts] = useState({});
  const [hlEdits, setHlEdits] = useState({});
  const [hlMarkers, setHlMarkers] = useState({});
  const [addingAt, setAddingAt] = useState(null);
  const [addForm, setAddForm] = useState({ subtitle: "", type: "A1" });
  const [fn, setFn] = useState("");
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState({p:0,l:""});
  const [gReady, setGReady] = useState(false);
  const [gBusy, setGBusy] = useState(false);
  const [aBlock, setABlock] = useState(null);
  const [showSet, setShowSet] = useState(false);
  const [err, setErr] = useState(null);
  const [shareUrl, setShareUrl] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [matchingMode, setMatchingMode] = useState(null);
  const [showSessions, setShowSessions] = useState(false);
  const [guideMode, setGuideMode] = useState(null);
  const [textSel, setTextSel] = useState(null);
  const [partialBusy, setPartialBusy] = useState(false);
  const [summaryCollapsed, setSummaryCollapsed] = useState(false);

  const lRef = useRef(null), rRef = useRef(null), bEls = useRef({});

  // ── localStorage 자동저장 ──
  useEffect(() => {
    if (blocks.length === 0) return;
    try {
      localStorage.setItem("se_session", JSON.stringify({ blocks, anal, hl, hlStats, hlVerdicts, hlEdits, hlMarkers, fn, gReady, guideMode }));
    } catch {}
  }, [blocks, anal, hl, hlStats, hlVerdicts, hlEdits, hlMarkers, fn, gReady, guideMode]);

  // ── 앱 마운트: URL 공유 파라미터 또는 localStorage 복원 ──
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sid = params.get("s");
    if (sid) {
      setSessionId(sid);
      setBusy(true); setProg({p:30,l:"공유 세션 불러오는 중..."});
      apiLoadSession(sid, cfg)
        .then(data => {
          setBlocks(data.blocks || []);
          setAnal(data.anal || null);
          setHl(data.hl || []);
          setHlStats(data.hlStats || null);
          setHlVerdicts(data.hlVerdicts || {}); setHlEdits(data.hlEdits || {}); setHlMarkers(data.hlMarkers || {});
          setFn(data.fn || "");
          setGReady((data.hl?.length > 0));
          setGuideMode(data.hl?.length > 0 ? (data.guideMode || "auto") : null);
          setProg({p:100,l:"✅ 공유 세션 로드 완료"});
        })
        .catch(e => setErr(e.message))
        .finally(() => setBusy(false));
    } else {
      try {
        const saved = localStorage.getItem("se_session");
        if (saved) {
          const s = JSON.parse(saved);
          if (s.blocks?.length > 0) {
            setBlocks(s.blocks); setAnal(s.anal || null);
            setHl(s.hl || []); setHlStats(s.hlStats || null);
            setHlVerdicts(s.hlVerdicts || {}); setHlEdits(s.hlEdits || {}); setHlMarkers(s.hlMarkers || {});
            setFn(s.fn || ""); setGReady(s.gReady || false);
            setGuideMode(s.guideMode || null);
          }
        }
      } catch {}
    }
  }, []); // eslint-disable-line

  const scrollTo = useCallback(i => {
    setABlock(i);
    const el = bEls.current[`g${i}`];
    if (el) {
      const container = el.closest('[data-scroll-container]');
      if (container) {
        const containerRect = container.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        const offset = elRect.top - containerRect.top + container.scrollTop - containerRect.height / 3;
        container.scrollTo({ top: offset, behavior: 'smooth' });
      }
    }
    if (rRef.current) {
      const hlEl = rRef.current.querySelector(`[data-hl-block="${i}"]`);
      if (hlEl) {
        const containerRect = rRef.current.getBoundingClientRect();
        const elRect = hlEl.getBoundingClientRect();
        const offset = elRect.top - containerRect.top + rRef.current.scrollTop - 60;
        rRef.current.scrollTo({ top: offset, behavior: 'smooth' });
      }
    }
  },[]);

  const saveCfg = useCallback(c=>{setCfg(c);saveConfig(c);setShowSet(false)},[]);

  // ── KV 자동저장 ──
  const autoSaveToKV = useCallback(async (overrideData = {}) => {
    if (cfg.apiMode === "mock") return;
    try {
      const payload = { blocks, anal, hl, hlStats, hlVerdicts, hlEdits, hlMarkers, fn, guideMode, ...overrideData };
      if (sessionId) payload.id = sessionId;
      const id = await apiSaveSession(payload, cfg);
      setSessionId(id);
      window.history.replaceState({}, "", `${window.location.pathname}?s=${id}`);
    } catch (e) { console.warn("자동 저장 실패:", e.message); }
  }, [blocks, anal, hl, hlStats, hlVerdicts, hlEdits, hlMarkers, fn, guideMode, cfg, sessionId]);

  const handleShare = useCallback(async () => {
    setSaving(true); setErr(null);
    try {
      const payload = { blocks, anal, hl, hlStats, hlVerdicts, hlEdits, hlMarkers, fn, guideMode };
      if (sessionId) payload.id = sessionId;
      const id = await apiSaveSession(payload, cfg);
      setSessionId(id);
      const url = `${window.location.origin}${window.location.pathname}?s=${id}`;
      setShareUrl(url);
      window.history.replaceState({}, "", `${window.location.pathname}?s=${id}`);
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  }, [blocks, anal, hl, hlStats, hlVerdicts, hlEdits, hlMarkers, fn, guideMode, cfg, sessionId]);

  const handleReset = useCallback(() => {
    localStorage.removeItem("se_session");
    setBlocks([]); setAnal(null); setHl([]); setHlStats(null); setHlVerdicts({}); setHlEdits({}); setHlMarkers({});
    setFn(""); setGReady(false); setGuideMode(null); setTextSel(null); setSessionId(null);
    window.history.replaceState({}, "", window.location.pathname);
  }, []);

  // Process file — analyze then go to guide
  const handleFile = useCallback(async(text,name)=>{
    setFn(name); setBusy(true); setErr(null); setHl([]); setHlStats(null); setGReady(false); setGuideMode(null); setTextSel(null);
    try {
      setProg({p:5,l:"텍스트 파싱 중..."});
      const parsed = parseBlocks(text); setBlocks(parsed);
      setProg({p:40,l:"사전 분석 중 (AI)..."});
      const ft = parsed.map(b=>`${b.speaker} ${b.timestamp}\n${b.text}`).join("\n\n");
      const speakerNames = [...new Set(parsed.map(b => b.speaker).filter(s => s && s !== "—"))];
      const speakerHint = speakerNames.length > 0
        ? `\n\n[화자명 라인에서 추출한 정확한 화자명 목록: ${speakerNames.join(", ")}]\n이 이름들은 사람이 직접 입력한 것이므로 정답 기준입니다.\n`
        : "";
      const a = await apiAnalyze(speakerHint + ft, cfg); setAnal(a);
      setProg({p:100,l:`✅ 사전 분석 완료`});
    } catch(e) { setErr(e.message); setProg({p:0,l:""}); }
    finally { setBusy(false); }
  },[cfg]);

  // ── 수동 자막 추가 ──
  const handleAddSubtitle = useCallback(() => {
    if (addingAt === null || !addForm.subtitle.trim()) return;
    const block = blocks.find(b => b.index === addingAt);
    const newItem = {
      block_index: addingAt, speaker: block?.speaker || "—",
      source_text: "", subtitle: addForm.subtitle.trim(),
      type: addForm.type, type_name: addForm.type === "B2" ? "용어 설명형" : "수동 추가",
      reason: "편집자 수동 추가", placement_hint: null, sequence_id: null, _manual: true,
    };
    setHl(prev => [...prev, newItem]);
    setHlVerdicts(prev => ({...prev, [`${newItem.block_index}-${newItem.subtitle}`]: "use"}));
    setAddingAt(null);
    setAddForm({ subtitle: "", type: "A1" });
  }, [addingAt, addForm, blocks]);

  // ── 용어 설명 AI 생성 ──
  const handleTermGen = useCallback(async () => {
    const term = addForm.termInput?.trim();
    if (!term) return;
    if (cfg.apiMode === "mock") { setAddForm(f => ({...f, subtitle: `${term}(Term) : Mock 용어 설명입니다.`})); return; }
    if (!cfg.workerUrl) { setErr("설정에서 Worker URL을 입력해주세요."); return; }
    setAddForm(f => ({...f, generating: true}));
    try {
      const block = blocks.find(b => b.index === addingAt);
      const context = block ? block.text.substring(0, 500) : "";
      const d = await apiCall("term-explain", { term, context }, cfg);
      if (d.result?.explanation) setAddForm(f => ({...f, subtitle: d.result.explanation, generating: false}));
      else setAddForm(f => ({...f, generating: false}));
    } catch (e) { setErr(e.message); setAddForm(f => ({...f, generating: false})); }
  }, [addForm.termInput, addingAt, blocks, cfg]);

  // Generate guide — 2-Pass
  const handleGuide = useCallback(async()=>{
    setGBusy(true); setErr(null);
    try {
      const HIGHLIGHT_CHUNK_SIZE = 40000;
      const OVERLAP_BLOCKS = 5;
      const hlChunks = [];
      let currentChunk = [], currentLen = 0;
      for (const b of blocks) {
        if (currentLen + b.text.length > HIGHLIGHT_CHUNK_SIZE && currentChunk.length > 0) {
          hlChunks.push(currentChunk);
          const overlap = currentChunk.slice(-OVERLAP_BLOCKS);
          currentChunk = [...overlap];
          currentLen = overlap.reduce((s, x) => s + x.text.length, 0);
        }
        currentChunk.push(b); currentLen += b.text.length;
      }
      if (currentChunk.length > 0) hlChunks.push(currentChunk);

      const totalChunks = hlChunks.length;
      const isSingleChunk = totalChunks === 1;

      // Pass 1: Draft
      let allDraftHighlights = [];
      for (let ci = 0; ci < totalChunks; ci++) {
        const chunkLabel = isSingleChunk ? "" : ` (청크 ${ci+1}/${totalChunks})`;
        setProg({p: 5 + Math.round((ci / totalChunks) * 35), l: `Pass 1: 강조자막 후보 생성 중${chunkLabel}...`});
        const draftResult = await apiHighlightsDraft(hlChunks[ci], anal, cfg, isSingleChunk ? undefined : ci, isSingleChunk ? undefined : totalChunks);
        allDraftHighlights.push(...(draftResult.highlights || []));
        if (cfg.apiMode === "live" && ci < totalChunks - 1) { setProg({p: 0, l: "청크 간 대기 중... ☕"}); await delay(5000); }
      }

      if (!isSingleChunk) {
        const seen = new Set();
        allDraftHighlights = allDraftHighlights.filter(h => {
          const key = `${h.block_index}-${h.subtitle}`;
          if (seen.has(key)) return false;
          seen.add(key); return true;
        });
      }

      setProg({p: 42, l: `Draft 완료: ${allDraftHighlights.length}건 후보`});
      if (cfg.apiMode === "live") { setProg({p: 45, l: "API 보호 대기 (약 15초)... ☕"}); await delay(15000); }

      // Pass 2: Editor
      let allFinalHighlights = [], allRemoved = [];
      if (isSingleChunk) {
        setProg({p: 55, l: "Pass 2: 검증·선별 중 (Editor Agent)..."});
        const editResult = await apiHighlightsEdit(blocks, anal, allDraftHighlights, cfg);
        allFinalHighlights = editResult.highlights || [];
        allRemoved = editResult.removed || [];
      } else {
        for (let ci = 0; ci < totalChunks; ci++) {
          setProg({p: 50 + Math.round((ci / totalChunks) * 40), l: `Pass 2: 검증 (청크 ${ci+1}/${totalChunks})...`});
          const chunkBlockIndices = new Set(hlChunks[ci].map(b => b.index));
          const chunkDrafts = allDraftHighlights.filter(h => chunkBlockIndices.has(h.block_index));
          if (chunkDrafts.length === 0) continue;
          const editResult = await apiHighlightsEdit(hlChunks[ci], anal, chunkDrafts, cfg, ci, totalChunks);
          allFinalHighlights.push(...(editResult.highlights || []));
          allRemoved.push(...(editResult.removed || []));
          if (cfg.apiMode === "live" && ci < totalChunks - 1) await delay(5000);
        }
        const seenFinal = new Set();
        allFinalHighlights = allFinalHighlights.filter(h => {
          const key = `${h.block_index}-${h.subtitle}`;
          if (seenFinal.has(key)) return false;
          seenFinal.add(key); return true;
        });
      }

      const finalStats = {
        draft_count: allDraftHighlights.length,
        final_count: allFinalHighlights.length,
        removal_rate: `${Math.round((1 - allFinalHighlights.length / Math.max(allDraftHighlights.length, 1)) * 100)}%`,
      };
      setHl(allFinalHighlights); setHlStats(finalStats);
      setProg({p:100,l:`✅ 강조자막 완료 (2-Pass${isSingleChunk ? "" : `, ${totalChunks}청크`})`}); setGReady(true);
      autoSaveToKV({ hl: allFinalHighlights, hlStats: finalStats });
    } catch(e) { setErr(e.message); }
    finally { setGBusy(false); }
  },[blocks,anal,cfg,autoSaveToKV]);

  // ── 직접 편집 모드: 텍스트 선택 ──
  const onGuideTextMouseUp = useCallback(() => {
    if (guideMode !== "manual") return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
    const selectedText = sel.toString().trim();
    if (selectedText.length < 10) return;
    const range = sel.getRangeAt(0);
    const container = lRef.current;
    if (!container || !container.contains(range.startContainer)) return;
    const blockIndices = new Set();
    for (const [idx, el] of Object.entries(bEls.current)) {
      if (idx.startsWith("g") && el && sel.containsNode(el, true)) blockIndices.add(parseInt(idx.slice(1)));
    }
    const indices = [...blockIndices].sort((a, b) => a - b);
    if (indices.length === 0) return;
    const preview = selectedText.length > 100 ? selectedText.substring(0, 100) + "…" : selectedText;
    setTextSel({ text: selectedText, blockIndices: indices, preview });
  }, [guideMode]);

  const clearTextSel = useCallback(() => { setTextSel(null); window.getSelection()?.removeAllRanges(); }, []);

  // ── 부분 생성 ──
  const handlePartialGenerate = useCallback(async () => {
    if (!textSel || !anal) return;
    setPartialBusy(true); setErr(null);
    const blockCount = textSel.blockIndices.length;
    const blockLabel = blockCount === 1 ? `블록 #${textSel.blockIndices[0]}` : `블록 #${textSel.blockIndices[0]}~#${textSel.blockIndices[textSel.blockIndices.length-1]}`;
    setProg({p:10,l:`${blockLabel} 강조자막 생성 중...`});
    try {
      const CONTEXT_PAD = 3;
      const minIdx = Math.min(...textSel.blockIndices);
      const maxIdx = Math.max(...textSel.blockIndices);
      const contextBlocks = blocks.filter(b => b.index >= minIdx - CONTEXT_PAD && b.index <= maxIdx + CONTEXT_PAD);
      if (contextBlocks.length === 0) throw new Error("선택된 블록이 없습니다");
      const maxItems = blockCount <= 3 ? 2 : blockCount <= 7 ? 3 : 5;

      setProg({p:30,l:`${blockLabel} 후보 생성 중...`});
      const body = { mode: "draft", blocks: contextBlocks, analysis: anal, target_block_indices: textSel.blockIndices, max_items: maxItems };
      const d = await apiCall("highlights", body, cfg);
      let highlights = (d.result?.highlights || []);
      if (highlights.length === 0) { setProg({p:100,l:"선택 구간에서 후보 없음"}); setPartialBusy(false); clearTextSel(); return; }

      const targetSet = new Set(textSel.blockIndices);
      highlights = highlights.filter(h => targetSet.has(h.block_index));
      if (highlights.length > maxItems) highlights = highlights.slice(0, maxItems);

      setHl(prev => {
        const existingKeys = new Set(prev.map(h => `${h.block_index}-${h.subtitle}`));
        const newItems = highlights.filter(h => !existingKeys.has(`${h.block_index}-${h.subtitle}`));
        return [...prev, ...newItems].sort((a, b) => (a.block_index || 0) - (b.block_index || 0));
      });
      setHlStats(prev => ({
        draft_count: (prev?.draft_count || 0) + (d.result?.highlights || []).length,
        final_count: (prev?.final_count || 0) + highlights.length,
        removal_rate: "부분 생성",
      }));
      setGReady(true);
      setProg({p:100,l:`✅ ${blockLabel}: ${highlights.length}건 생성`});
      clearTextSel();
      autoSaveToKV();
    } catch(e) { setErr(e.message); }
    finally { setPartialBusy(false); }
  }, [textSel, blocks, anal, cfg, clearTextSel, autoSaveToKV]);

  const guides = useMemo(()=> [...hl].sort((a,b) => (a.block_index||0) - (b.block_index||0)),[hl]);

  const hasData = blocks.length > 0 && !busy;

  // ── 형광펜 마커 ──
  const handleMarkerAdd = useCallback((key, color, blockIdx, s, e) => {
    setHlMarkers(prev => {
      const existing = prev[key] || { color, ranges: [] };
      const prevRanges = existing.color === color ? existing.ranges : [];
      const newRanges = [...prevRanges];
      let merged = false;
      for (let i = 0; i < newRanges.length; i++) {
        const r = newRanges[i];
        if (r.blockIdx === blockIdx && !(e <= r.s || s >= r.e)) {
          newRanges[i] = { blockIdx, s: Math.min(s, r.s), e: Math.max(e, r.e) };
          merged = true; break;
        }
      }
      if (!merged) newRanges.push({ blockIdx, s, e });
      return { ...prev, [key]: { color, ranges: newRanges } };
    });
  }, []);

  // file upload
  const onFileUpload = useCallback(async(file)=>{
    if(!file) return;
    if(file.name.endsWith(".docx")){
      const buf = await file.arrayBuffer();
      const res = await mammoth.extractRawText({arrayBuffer:buf});
      handleFile(res.value, file.name);
    } else {
      const text = await file.text();
      handleFile(text, file.name);
    }
  },[handleFile]);

  const fileRef = useRef(null);
  const [drag,setDrag] = useState(false);

  return <div style={{height:"100vh",background:C.bg,color:C.tx,fontFamily:FN,display:"flex",flexDirection:"column"}}>
    {/* HEADER */}
    <header style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 20px",height:52,
      borderBottom:`1px solid ${C.bd}`,background:C.sf,flexShrink:0}}>
      <div style={{display:"flex",alignItems:"center",gap:10}}>
        <span style={{fontSize:18,fontWeight:800,letterSpacing:"-0.03em"}}>
          <span style={{color:C.hBd}}>S</span>ubtitle <span style={{color:C.ac}}>E</span>ffect
        </span>
        {fn && <span style={{fontSize:11,color:C.txD,padding:"2px 8px",background:C.glass,borderRadius:4}}>{fn}</span>}
        <span style={{fontSize:10,padding:"2px 6px",borderRadius:3,fontWeight:600,
          background:cfg.apiMode==="live"?C.cBg:C.fBg,
          color:cfg.apiMode==="live"?C.ok:C.wn}}>{cfg.apiMode==="live"?"LIVE":"MOCK"}</span>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:8}}>
        {hasData && (
          <button onClick={handleShare} disabled={saving} style={{padding:"5px 14px",borderRadius:6,border:"none",
            background:saving?C.acFade:sessionId?C.gradShare:C.gradAc,
            color:C.btnTx,fontSize:12,fontWeight:600,cursor:saving?"not-allowed":"pointer"}}>
            {saving?"저장 중…":sessionId?"↑ 업데이트":"🔗 공유"}
          </button>
        )}
        {hasData && sessionId && (
          <button onClick={()=>setSessionId(null)} title="새 공유 링크 생성"
            style={{padding:"5px 8px",borderRadius:6,border:`1px solid ${C.bd}`,
              background:"transparent",color:C.txM,fontSize:11,cursor:"pointer"}}>+ 새 링크</button>
        )}
        {hasData && (
          <button onClick={handleReset} title="새 파일 시작" style={{padding:"5px 10px",borderRadius:6,
            border:`1px solid ${C.bd}`,background:"transparent",color:C.txM,fontSize:12,cursor:"pointer"}}>
            ✕ 새 파일
          </button>
        )}
        <button onClick={()=>setShowSessions(true)} title="작업 히스토리"
          style={{padding:"5px 10px",borderRadius:6,border:`1px solid ${C.bd}`,
            background:"transparent",color:C.txM,fontSize:12,cursor:"pointer"}}>📋</button>
        <button onClick={toggleTheme} title={theme==="dark"?"라이트 모드":"다크 모드"}
          style={{padding:"5px 10px",borderRadius:6,border:`1px solid ${C.bd}`,
            background:"transparent",color:C.txM,fontSize:12,cursor:"pointer"}}>{theme==="dark"?"☀️":"🌙"}</button>
        <button onClick={()=>setShowSet(true)} style={{padding:"5px 10px",borderRadius:6,border:`1px solid ${C.bd}`,
          background:"transparent",color:C.txM,fontSize:12,cursor:"pointer"}}>⚙️</button>
      </div>
    </header>

    {err && <div style={{padding:"10px 20px",background:C.tBanner,borderBottom:`1px solid ${C.tBorder}`,
      fontSize:13,color:C.tTx,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
      <span>⚠️ {err}</span>
      <button onClick={()=>setErr(null)} style={{background:"none",border:"none",color:C.tTx,cursor:"pointer",fontSize:16}}>✕</button>
    </div>}

    {(busy||gBusy||partialBusy) && <div style={{padding:"0 20px",flexShrink:0}}><Progress pct={prog.p} label={prog.l}/></div>}

    {/* 분석 중 요약 표시 */}
    {busy && anal?.editorial_summary && (
      <div style={{padding:"0 20px",flexShrink:0,maxWidth:680,margin:"0 auto",width:"100%"}}>
        <EditorialSummaryPanel summary={anal.editorial_summary} collapsed={summaryCollapsed} onToggle={()=>setSummaryCollapsed(p=>!p)}/>
      </div>
    )}

    <main style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
      {/* EMPTY — 파일 업로드 */}
      {!hasData && !busy && <div style={{padding:"40px 24px",maxWidth:520,margin:"0 auto",width:"100%"}}>
        <div onDragOver={e=>{e.preventDefault();setDrag(true)}} onDragLeave={()=>setDrag(false)}
          onDrop={e=>{e.preventDefault();setDrag(false);onFileUpload(e.dataTransfer.files[0])}}
          onClick={()=>fileRef.current?.click()}
          style={{border:`2px dashed ${drag?C.ac:C.bd}`,borderRadius:16,padding:"56px 32px",textAlign:"center",
            cursor:"pointer",background:drag?C.acS:"transparent",transition:"all 0.2s"}}>
          <div style={{fontSize:44,marginBottom:14,opacity:0.5}}>💬</div>
          <div style={{fontSize:16,fontWeight:600,color:C.tx,marginBottom:6}}>docx 또는 txt 파일을 드래그하거나 클릭</div>
          <div style={{fontSize:12,color:C.txD}}>인터뷰 STT 원고 → AI 강조자막 생성</div>
          <input ref={fileRef} type="file" accept=".docx,.txt" style={{display:"none"}}
            onChange={e=>onFileUpload(e.target.files?.[0])}/>
        </div>
        <p style={{textAlign:"center",fontSize:13,color:C.txD,lineHeight:1.8,marginTop:16}}>
          파일 업로드 → 사전 분석 → 2-Pass 강조자막 생성<br/>
          (Draft Agent → Editor Agent)
        </p>
      </div>}

      {/* 분석 완료, 가이드 모드 미선택 */}
      {hasData && !guideMode && !gReady && !gBusy && <div style={{flex:1,overflowY:"auto",padding:"32px 24px"}}>
        <div style={{maxWidth:640,margin:"0 auto"}}>
        <div style={{display:"flex",gap:16,justifyContent:"center",flexWrap:"wrap",marginBottom:24}}>
          <div onClick={()=>{setGuideMode("auto");handleGuide()}}
            style={{flex:"1 1 260px",maxWidth:300,padding:"28px 24px",borderRadius:14,cursor:"pointer",
              border:`2px solid ${C.ac}44`,background:C.sf,transition:"all 0.15s",
              boxShadow:`0 2px 12px ${C.acFade}`,textAlign:"left"}}
            onMouseEnter={e=>{e.currentTarget.style.borderColor=C.ac}}
            onMouseLeave={e=>{e.currentTarget.style.borderColor=`${C.ac}44`}}>
            <div style={{fontSize:28,marginBottom:10}}>🤖</div>
            <div style={{fontSize:15,fontWeight:700,color:C.tx,marginBottom:6}}>AI 일괄 생성</div>
            <div style={{fontSize:12,color:C.txM,lineHeight:1.6}}>
              Draft Agent가 후보를 넉넉히 생성 → Editor Agent가 검증·선별.<br/>
              전체 원고를 자동으로 분석합니다.
            </div>
          </div>
          <div onClick={()=>{setGuideMode("manual");setGReady(true)}}
            style={{flex:"1 1 260px",maxWidth:300,padding:"28px 24px",borderRadius:14,cursor:"pointer",
              border:`2px solid ${C.hBd}44`,background:C.sf,transition:"all 0.15s",
              boxShadow:`0 2px 12px ${C.hShadow||"rgba(0,0,0,0.08)"}`,textAlign:"left"}}
            onMouseEnter={e=>{e.currentTarget.style.borderColor=C.hBd}}
            onMouseLeave={e=>{e.currentTarget.style.borderColor=`${C.hBd}44`}}>
            <div style={{fontSize:28,marginBottom:10}}>✏️</div>
            <div style={{fontSize:15,fontWeight:700,color:C.tx,marginBottom:6}}>직접 편집하기</div>
            <div style={{fontSize:12,color:C.txM,lineHeight:1.6}}>
              원고를 읽으며 텍스트를 드래그하여 부분 생성.<br/>
              수동 추가와 AI 부분 생성을 자유롭게 조합합니다.
            </div>
          </div>
        </div>
        <div style={{display:"flex",justifyContent:"center",marginBottom:20}}>
          <div style={{display:"inline-flex",alignItems:"center",gap:6,padding:"5px 12px",borderRadius:16,
            background:C.cBg,border:`1px solid ${C.cBorder}`,fontSize:12,color:C.ok}}>
            ✅ 사전 분석 완료 — {blocks.length}블록
          </div>
        </div>
        {anal?.editorial_summary && <div style={{marginBottom:24}}>
          <EditorialSummaryPanel summary={anal.editorial_summary} collapsed={summaryCollapsed} onToggle={()=>setSummaryCollapsed(p=>!p)}/>
        </div>}
        </div>
      </div>}

      {/* ── 메인 가이드 뷰 ── */}
      {gReady && <div style={{flex:1,display:"flex",overflow:"hidden",position:"relative"}}>
        {/* 좌: 원고 */}
        <div ref={lRef} data-scroll-container onMouseUp={onGuideTextMouseUp}
          style={{flex:1,overflowY:"auto",borderRight:`1px solid ${C.bd}`}}>
          <div style={{padding:"8px 16px",fontSize:11,fontWeight:700,color:C.txD,textTransform:"uppercase",
            letterSpacing:"0.08em",borderBottom:`1px solid ${C.bd}`,position:"sticky",top:0,background:C.bg,zIndex:2,
            display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span>원고{guideMode==="manual"?" — 텍스트 드래그로 구간 생성":""}</span>
            {guideMode==="manual" && <button onClick={()=>handleGuide()} disabled={gBusy}
              style={{fontSize:10,fontWeight:600,padding:"3px 10px",borderRadius:5,border:"none",
                background:gBusy?C.acFade:C.gradAc,color:C.btnTx,cursor:gBusy?"not-allowed":"pointer"}}>
              {gBusy?"생성 중...":"▶ 일괄 생성"}</button>}
          </div>
          {matchingMode && <div style={{padding:"6px 16px",background:MARKER_COLORS[matchingMode.color]?.bg,
            borderBottom:`1px solid ${MARKER_COLORS[matchingMode.color]?.border}`,
            display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:28,zIndex:2}}>
            <span style={{fontSize:12,fontWeight:600,color:MARKER_COLORS[matchingMode.color]?.border}}>
              🖍 블록 #{matchingMode.blockIdx}에서 텍스트를 드래그하여 형광펜을 칠하세요
            </span>
            <button onClick={()=>setMatchingMode(null)}
              style={{fontSize:11,padding:"2px 10px",borderRadius:4,border:`1px solid ${MARKER_COLORS[matchingMode.color]?.border}`,
                background:C.inputBg,color:MARKER_COLORS[matchingMode.color]?.border,cursor:"pointer",fontWeight:600}}>완료</button>
          </div>}
          {blocks.map(b=>{
            const idx = b.index;
            const activeMatchBlock = matchingMode ? matchingMode.blockIdx : null;
            return <div key={idx}>
            <div ref={el=>{if(el)bEls.current[`g${idx}`]=el}} onClick={()=>scrollTo(idx)}
              style={{padding:"10px 16px",
                borderLeft:`4px solid ${aBlock===idx?C.hBd:"transparent"}`,
                background:aBlock===idx?C.hLight:"transparent",
                cursor:"pointer",transition:"all 0.25s ease"}}>
              <div style={{marginBottom:4,display:"flex",alignItems:"center",gap:6}}>
                <span style={{fontSize:10,fontWeight:700,color:C.txD,fontFamily:"monospace",
                  background:C.glass2,padding:"1px 5px",borderRadius:3}}>#{idx}</span>
                <Badge name={b.speaker}/>
                <span style={{fontSize:11,color:C.txD,fontFamily:"monospace"}}>{b.timestamp}</span>
                {activeMatchBlock===idx && <span style={{fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:3,
                  background:MARKER_COLORS[matchingMode?.color]?.bg,color:MARKER_COLORS[matchingMode?.color]?.border,
                  border:`1px solid ${MARKER_COLORS[matchingMode?.color]?.border}`}}>
                  🖍 드래그로 구간 선택</span>}
              </div>
              <MarkedText text={b.text} blockIdx={idx}
                hlMarkers={hlMarkers}
                matchingMode={activeMatchBlock===idx ? matchingMode : null}
                onMarkerAdd={handleMarkerAdd}/>
              {/* 블록 클릭 시 우하단 자막 추가 버튼 */}
              {aBlock===idx && addingAt!==idx && (
                <div style={{padding:"4px 16px 8px",display:"flex",justifyContent:"flex-end"}}>
                  <button onClick={e=>{e.stopPropagation();setAddingAt(idx);setAddForm({subtitle:"",type:"A1"})}}
                    style={{fontSize:11,fontWeight:600,padding:"4px 12px",borderRadius:6,
                      border:`1px dashed ${C.hBd}`,background:C.hLight,
                      color:C.hBd,cursor:"pointer"}}>+ 자막 추가</button>
                </div>
              )}
            </div>
            {/* 자막 추가 입력 폼 */}
            {addingAt===idx && (
              <div onClick={e=>e.stopPropagation()} style={{margin:"0 16px 10px",padding:12,borderRadius:10,
                border:`1px solid ${C.hBd}`,background:C.hFaint}}>
                <div style={{display:"flex",gap:6,marginBottom:8}}>
                  {[["A1","강조자막"],["B2","용어 설명"]].map(([t,l])=>
                    <button key={t} onClick={()=>setAddForm(f=>({...f,type:t}))}
                      style={{fontSize:11,fontWeight:600,padding:"3px 10px",borderRadius:5,cursor:"pointer",
                        border:`1px solid ${addForm.type===t?C.hBd:"transparent"}`,
                        background:addForm.type===t?C.hBg:C.glass,
                        color:addForm.type===t?C.hBd:C.txD}}>{l}</button>)}
                </div>
                {addForm.type==="B2" && (
                  <div style={{display:"flex",gap:4,marginBottom:6}}>
                    <input value={addForm.termInput||""} onChange={e=>setAddForm(f=>({...f,termInput:e.target.value}))}
                      placeholder="용어를 입력하세요 (예: 에이전트)"
                      style={{flex:1,padding:"5px 8px",borderRadius:6,border:`1px solid ${C.bd}`,
                        background:C.inputBg,color:C.tx,fontSize:12,outline:"none"}}
                      onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();handleTermGen();}}}/>
                    <button onClick={handleTermGen} disabled={addForm.generating}
                      style={{fontSize:11,fontWeight:600,padding:"4px 10px",borderRadius:5,border:"none",
                        background:addForm.generating?C.acFade:C.ac,
                        color:C.btnTx,cursor:addForm.generating?"not-allowed":"pointer",whiteSpace:"nowrap"}}>
                      {addForm.generating?"생성 중...":"AI 설명 생성"}</button>
                  </div>
                )}
                <textarea value={addForm.subtitle} onChange={e=>setAddForm(f=>({...f,subtitle:e.target.value}))}
                  placeholder={addForm.type==="B2"?"용어(English) : 설명":"강조자막 내용"}
                  rows={2} autoFocus={addForm.type!=="B2"}
                  style={{width:"100%",padding:"6px 8px",borderRadius:6,border:`1px solid ${C.bd}`,
                    background:C.inputBg,color:C.tx,fontSize:13,fontFamily:FN,
                    lineHeight:1.5,resize:"vertical",outline:"none"}}
                  onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();handleAddSubtitle();}if(e.key==="Escape")setAddingAt(null);}}/>
                <div style={{display:"flex",gap:4,marginTop:6,justifyContent:"flex-end"}}>
                  <button onClick={()=>setAddingAt(null)}
                    style={{fontSize:11,padding:"3px 10px",borderRadius:4,border:`1px solid ${C.bd}`,
                      background:"transparent",color:C.txM,cursor:"pointer"}}>취소</button>
                  <button onClick={handleAddSubtitle}
                    style={{fontSize:11,padding:"3px 10px",borderRadius:4,border:"none",
                      background:C.hBd,color:C.btnTx,fontWeight:600,cursor:"pointer"}}>추가</button>
                </div>
              </div>
            )}
            {/* 사용 판정된 자막 인라인 카드 */}
            {(() => {
              const usedGuides = guides.filter(g => g.block_index === idx && hlVerdicts[`${g.block_index}-${g.subtitle}`] === "use");
              if (usedGuides.length === 0) return null;
              const swapInHl = (gA, gB) => {
                setHl(prev => {
                  const next = [...prev];
                  const iA = next.indexOf(gA), iB = next.indexOf(gB);
                  if (iA === -1 || iB === -1) return prev;
                  [next[iA], next[iB]] = [next[iB], next[iA]];
                  return next;
                });
              };
              return usedGuides.map((g, gi) => {
                const gKey = `${g.block_index}-${g.subtitle}`;
                const gEditedText = hlEdits[gKey];
                const gHasEdit = gEditedText && gEditedText !== g.subtitle;
                const displaySubtitle = gHasEdit ? gEditedText : g.subtitle;
                const canUp = gi > 0, canDown = gi < usedGuides.length - 1;
                const marker = hlMarkers[gKey];
                const mc = marker?.color ? MARKER_COLORS[marker.color] : null;
                const isActiveMatch = matchingMode?.key === gKey;
                return <div key={`inline-${gi}`} style={{margin:"2px 16px 4px",padding:"8px 12px",borderRadius:8,
                  border:`1px solid ${mc ? mc.border : C.cStrong}`,
                  background:mc ? mc.bg.replace("0.3","0.08") : C.cLight,
                  display:"flex",alignItems:"center",gap:8,
                  boxShadow:isActiveMatch?`0 0 0 2px ${mc?.border||C.ac}`:"none",transition:"all 0.15s"}}>
                  {usedGuides.length > 1 && <div style={{display:"flex",flexDirection:"column",gap:1,flexShrink:0}}>
                    <button onClick={e=>{e.stopPropagation();if(canUp)swapInHl(g,usedGuides[gi-1])}}
                      disabled={!canUp}
                      style={{fontSize:9,lineHeight:1,padding:"1px 4px",border:"none",borderRadius:3,
                        background:canUp?C.glass3:"transparent",color:canUp?C.txM:"transparent",cursor:canUp?"pointer":"default"}}>▲</button>
                    <button onClick={e=>{e.stopPropagation();if(canDown)swapInHl(g,usedGuides[gi+1])}}
                      disabled={!canDown}
                      style={{fontSize:9,lineHeight:1,padding:"1px 4px",border:"none",borderRadius:3,
                        background:canDown?C.glass3:"transparent",color:canDown?C.txM:"transparent",cursor:canDown?"pointer":"default"}}>▼</button>
                  </div>}
                  <span style={{fontSize:11,color:mc?.border||C.cTx,fontWeight:700,flexShrink:0}}>▶</span>
                  <TypeBadge type={g.type}/>
                  <div style={{flex:1,fontSize:13,fontWeight:500,color:mc?.border||C.cTx,lineHeight:1.4,whiteSpace:"pre-line"}}>
                    {displaySubtitle}
                  </div>
                  {/* 형광펜 버튼 */}
                  <div style={{display:"flex",gap:2,flexShrink:0}}>
                    {Object.entries(MARKER_COLORS).map(([ck,cv]) => (
                      <button key={ck} onClick={e=>{
                        e.stopPropagation();
                        if (matchingMode?.key === gKey && matchingMode?.color === ck) { setMatchingMode(null); }
                        else { setMatchingMode({ key: gKey, color: ck, blockIdx: g.block_index }); }
                      }}
                        style={{width:14,height:14,borderRadius:3,border:matchingMode?.key===gKey&&matchingMode?.color===ck?`2px solid ${cv.border}`:`1px solid ${C.bd}`,
                          background:cv.bg,cursor:"pointer",padding:0}}/>
                    ))}
                    {hlMarkers[gKey] && <button onClick={e=>{e.stopPropagation();setHlMarkers(prev=>{const n={...prev};delete n[gKey];return n;});}}
                      style={{fontSize:9,color:C.txD,background:"none",border:"none",cursor:"pointer",padding:"0 2px"}}>✕</button>}
                  </div>
                </div>;
              });
            })()}
            </div>;
          })}
        </div>

        {/* 우: 강조자막 목록 */}
        <div ref={rRef} data-scroll-container style={{width:420,minWidth:380,overflowY:"auto",background:C.panelBg}}>
          <div style={{padding:"8px 14px",fontSize:11,fontWeight:700,color:C.txD,textTransform:"uppercase",
            letterSpacing:"0.08em",borderBottom:`1px solid ${C.bd}`,position:"sticky",top:0,background:C.sf,zIndex:2,
            display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span>강조자막 ({hl.length})</span>
            {hlStats && <span style={{fontSize:10,color:C.txD,fontWeight:400,textTransform:"none"}}>
              Draft {hlStats.draft_count} → Final {hlStats.final_count}
            </span>}
          </div>
          <div style={{padding:"8px 10px"}}>
            {!guides.length && guideMode!=="manual" && <p style={{padding:20,textAlign:"center",fontSize:12,color:C.txD}}>항목 없음</p>}
            {guides.map((g,i)=><div key={`hl-${i}`} data-hl-block={g.block_index}>
              <GuideCard item={g}
              blocks={blocks}
              active={aBlock===g.block_index}
              onClick={g2=>scrollTo(g2.block_index)}
              verdict={hlVerdicts[`${g.block_index}-${g.subtitle}`]}
              onVerdict={(item, v) => setHlVerdicts(prev => ({...prev, [`${item.block_index}-${item.subtitle}`]: v}))}
              editedText={hlEdits[`${g.block_index}-${g.subtitle}`]}
              onEdit={(item, text) => setHlEdits(prev => {
                const key = `${item.block_index}-${item.subtitle}`;
                const next = {...prev};
                if (text === null) delete next[key]; else next[key] = text;
                return next;
              })}
              onRelocate={(item, newIdx) => {
                const oldKey = `${item.block_index}-${item.subtitle}`;
                const newKey = `${newIdx}-${item.subtitle}`;
                setHl(prev => prev.map(h => h === item ? {...h, block_index: newIdx} : h));
                setHlVerdicts(prev => {
                  const next = {...prev};
                  if (next[oldKey] !== undefined) { next[newKey] = next[oldKey]; delete next[oldKey]; }
                  return next;
                });
                setHlEdits(prev => {
                  const next = {...prev};
                  if (next[oldKey] !== undefined) { next[newKey] = next[oldKey]; delete next[oldKey]; }
                  return next;
                });
              }}
            />
            </div>)}
          </div>
        </div>

        {/* 텍스트 선택 플로팅 바 */}
        {textSel && guideMode==="manual" && (
          <div style={{position:"absolute",bottom:60,left:"50%",transform:"translateX(-50%)",
            padding:"10px 18px",borderRadius:12,background:C.sf,
            border:`2px solid ${C.hBd}`,boxShadow:`0 8px 32px rgba(0,0,0,0.25)`,
            display:"flex",alignItems:"center",gap:12,zIndex:20,maxWidth:"90%"}}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:11,color:C.txD,marginBottom:2}}>
                블록 #{textSel.blockIndices[0]}{textSel.blockIndices.length>1?`~#${textSel.blockIndices[textSel.blockIndices.length-1]}`:""} ({textSel.blockIndices.length}개 블록)
              </div>
              <div style={{fontSize:12,color:C.txM,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                "{textSel.preview}"
              </div>
            </div>
            <button onClick={handlePartialGenerate} disabled={partialBusy}
              style={{fontSize:12,fontWeight:700,padding:"8px 16px",borderRadius:8,border:"none",
                background:partialBusy?C.acFade:C.gradAc,color:C.btnTx,
                cursor:partialBusy?"not-allowed":"pointer",whiteSpace:"nowrap",
                boxShadow:`0 2px 8px ${C.acFade}`}}>
              {partialBusy?"생성 중...":"🤖 AI 강조자막 생성"}</button>
            <button onClick={clearTextSel}
              style={{fontSize:14,padding:"4px 8px",borderRadius:6,border:`1px solid ${C.bd}`,
                background:"transparent",color:C.txM,cursor:"pointer",lineHeight:1}}>✕</button>
          </div>
        )}
      </div>}

      {/* 하단 상태 바 */}
      {gReady && <div style={{display:"flex",gap:20,padding:"10px 20px",background:C.sf,borderTop:`1px solid ${C.bd}`,
        fontSize:13,color:C.txM,flexShrink:0}}>
        <span>강조자막: <b style={{color:C.hBd}}>{hl.length}</b></span>
        {hlStats && <>
          <span style={{color:C.txD}}>|</span>
          <span style={{fontSize:12}}>Draft {hlStats.draft_count}건 → Final {hlStats.final_count}건 ({hlStats.removal_rate} 필터링)</span>
        </>}
        {(() => {
          const vals = Object.values(hlVerdicts).filter(Boolean);
          const useC = vals.filter(v=>v==="use").length;
          const disC = vals.filter(v=>v==="discard").length;
          const unchk = hl.length - useC - disC;
          if (useC + disC === 0) return null;
          return <>
            <span style={{color:C.txD}}>|</span>
            <span style={{fontSize:12}}>
              <span style={{color:C.cTx}}>사용 {useC}</span>
              {" · "}<span style={{color:C.tTx}}>폐기 {disC}</span>
              {" · "}<span style={{color:C.txD}}>미선택 {unchk}</span>
            </span>
          </>;
        })()}
      </div>}
    </main>

    {showSet && <SettingsModal config={cfg} onSave={saveCfg} onClose={()=>setShowSet(false)}/>}
    {shareUrl && <ShareModal shareUrl={shareUrl} onClose={()=>setShareUrl(null)}/>}
    {showSessions && <SessionListModal config={cfg} onClose={()=>setShowSessions(false)}
      onLoad={async(id)=>{
        setShowSessions(false);
        setBusy(true); setProg({p:30,l:"세션 불러오는 중..."});
        try {
          const data = await apiLoadSession(id, cfg);
          setBlocks(data.blocks || []); setAnal(data.anal || null);
          setHl(data.hl || []); setHlStats(data.hlStats || null);
          setHlVerdicts(data.hlVerdicts || {}); setHlEdits(data.hlEdits || {}); setHlMarkers(data.hlMarkers || {});
          setFn(data.fn || ""); setSessionId(id);
          setGReady((data.hl?.length > 0));
          setGuideMode(data.hl?.length > 0 ? (data.guideMode || "auto") : null);
          window.history.replaceState({}, "", `${window.location.pathname}?s=${id}`);
          setProg({p:100,l:"✅ 세션 로드 완료"});
        } catch(e) { setErr(e.message); }
        finally { setBusy(false); }
      }}
    />}

    <style>{`
      @import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css');
      *{box-sizing:border-box;margin:0;padding:0}
      ::-webkit-scrollbar { width: 10px; height: 10px; }
      ::-webkit-scrollbar-track { background: ${C.glassHover}; }
      ::-webkit-scrollbar-thumb { background: ${C.glass3}; border-radius: 5px; }
      ::-webkit-scrollbar-thumb:hover { background: ${C.inputBg}; }
      body{overflow:hidden}
    `}</style>
  </div>;
}
