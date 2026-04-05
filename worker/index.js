// subtitle_effect — Cloudflare Worker
// 엔드포인트: /analyze, /highlights, /term-explain, /save, /load/:id, /sessions, /sessions/delete
// ttimes-doctor에서 강조자막 기능만 추출한 독립 Worker

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/debug-location") {
      return new Response(JSON.stringify({ colo: request.cf?.colo, country: request.cf?.country, city: request.cf?.city }), { headers: corsHeaders });
    }

    const loadMatch = path.match(/^\/load\/([a-zA-Z0-9]+)$/);
    if (loadMatch && request.method === "GET") {
      return await handleLoad(loadMatch[1], env, corsHeaders);
    }

    if (path === "/sessions" && request.method === "GET") {
      return await handleSessionList(env, corsHeaders);
    }

    if (path === "/sessions/delete" && request.method === "POST") {
      try {
        const body = await request.json();
        return await handleSessionDelete(body, env, corsHeaders);
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    try {
      const body = await request.json();

      if (path === "/save") return await handleSave(body, env, corsHeaders);
      else if (path === "/analyze") return await handleAnalyze(body, env, corsHeaders);
      else if (path === "/highlights") return await handleHighlights(body, env, corsHeaders);
      else if (path === "/term-explain") return await handleTermExplain(body, env, corsHeaders);
      else return new Response(JSON.stringify({ error: "Unknown endpoint" }), { status: 404, headers: corsHeaders });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
    }
  },
};

// ═══════════════════════════════════════
// /save, /load, /sessions
// ═══════════════════════════════════════

async function handleSave(body, env, headers) {
  if (!env.SESSIONS) return new Response(JSON.stringify({ error: "KV not configured" }), { status: 500, headers });
  const id = body.id || Array.from(crypto.getRandomValues(new Uint8Array(5))).map(b => b.toString(36)).join("").slice(0, 8);
  const { id: _discardId, ...dataWithoutId } = body;
  const savedAt = new Date().toISOString();
  await env.SESSIONS.put(id, JSON.stringify({ ...dataWithoutId, savedAt }), { expirationTtl: 60*60*24*30 });

  try {
    const indexData = await env.SESSIONS.get("session_index");
    const index = indexData ? JSON.parse(indexData) : [];
    const existing = index.findIndex(s => s.id === id);
    const entry = {
      id,
      fn: body.fn || "제목 없음",
      savedAt,
      blockCount: body.blocks?.length || 0,
      hasGuide: (body.hl?.length || 0) > 0,
    };
    if (existing >= 0) {
      index[existing] = entry;
    } else {
      index.unshift(entry);
    }
    const trimmed = index.slice(0, 200);
    await env.SESSIONS.put("session_index", JSON.stringify(trimmed));
  } catch (e) {
    console.error("세션 인덱스 업데이트 실패:", e.message);
  }

  return new Response(JSON.stringify({ success: true, id }), { headers });
}

async function handleSessionList(env, headers) {
  if (!env.SESSIONS) return new Response(JSON.stringify({ error: "KV not configured" }), { status: 500, headers });
  const indexData = await env.SESSIONS.get("session_index");
  const index = indexData ? JSON.parse(indexData) : [];
  return new Response(JSON.stringify({ success: true, sessions: index }), { headers });
}

async function handleSessionDelete(body, env, headers) {
  if (!env.SESSIONS) return new Response(JSON.stringify({ error: "KV not configured" }), { status: 500, headers });
  const { id } = body;
  if (!id) return new Response(JSON.stringify({ error: "id required" }), { status: 400, headers });
  await env.SESSIONS.delete(id);
  try {
    const indexData = await env.SESSIONS.get("session_index");
    const index = indexData ? JSON.parse(indexData) : [];
    const filtered = index.filter(s => s.id !== id);
    await env.SESSIONS.put("session_index", JSON.stringify(filtered));
  } catch (e) {}
  return new Response(JSON.stringify({ success: true }), { headers });
}

async function handleLoad(id, env, headers) {
  if (!env.SESSIONS) return new Response(JSON.stringify({ error: "KV not configured" }), { status: 500, headers });
  const data = await env.SESSIONS.get(id);
  if (!data) return new Response(JSON.stringify({ error: "세션을 찾을 수 없습니다." }), { status: 404, headers });
  return new Response(data, { headers });
}

// ═══════════════════════════════════════
// OpenAI API 호출 공통 함수
// ═══════════════════════════════════════

async function callOpenAI(systemPrompt, userMessage, env, options = {}) {
  const { temperature = 0.1, max_tokens = 16000, model = "gpt-5.1" } = options;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature,
      max_completion_tokens: max_tokens,
      response_format: { type: "json_object" },
    }),
  });

  if (response.status === 429) {
    return { error: "Rate limited. Please wait and retry.", status: 429 };
  }

  if (!response.ok) {
    const errText = await response.text();
    return { error: `OpenAI API error ${response.status}: ${errText}`, status: response.status };
  }

  const data = await response.json();
  const finish_reason = data.choices?.[0]?.finish_reason;
  const content = data.choices?.[0]?.message?.content;

  if (finish_reason === "length") {
    return {
      error: `출력 토큰 한계 초과 (finish_reason: length). max_tokens=${max_tokens}. 입력을 더 작게 분할해주세요.`,
      status: 413,
    };
  }

  if (!content) {
    return { error: `Empty response from OpenAI. finish_reason: ${finish_reason}. Model: ${data.model}` };
  }

  let jsonStr = content.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();
  const braceStart = jsonStr.indexOf('{');
  const braceEnd = jsonStr.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd !== -1) {
    jsonStr = jsonStr.substring(braceStart, braceEnd + 1);
  }

  try {
    return { content: JSON.parse(jsonStr), usage: data.usage, finish_reason };
  } catch (e) {
    return { error: `JSON parse error: ${e.message}. Raw (first 300): ${content.substring(0, 300)}` };
  }
}

// ═══════════════════════════════════════
// /analyze — Step 0: 사전 분석
// ═══════════════════════════════════════

const ANALYZE_PROMPT = `You are a pre-analysis specialist for Korean interview transcripts produced by STT (Speech-to-Text).
Read the entire interview transcript below and extract the preliminary information needed for subsequent highlight subtitle generation.

## Information to Extract

### 1. Interview Overview
- Topic (1 line, in Korean)
- Core keywords (5–15, in Korean)

### 1-1. Editorial Summary
Provide a quick-reference summary so the editor can grasp the interview content.
- **One-liner**: What this interview is about, 1–2 sentences (~30 Korean chars)
- **Key points** (3–5): Major topics/arguments covered, in short sentences, listed in chronological order. Write in Korean.
- **Notable quotes** (2–3): Memorable verbatim quotes that could become subtitle highlights. Include the speaker name. Write in Korean.
- **Editor notes**: Technical-term-dense segments, controversial/sensitive remarks, unusual structure. 1–3 lines. Write in Korean.

### 2. Speaker Information (★ Highest Priority)
- Speaker-name lines (e.g., "홍재의 00:00", "강정수 박사님 00:25") are **manually typed by humans** and serve as the ground truth for correct names.
- Extract the name and title/affiliation separately from each speaker-name line.
- Confirm the spelling from speaker-name lines as canonical.

### 3. STT Misrecognition Dictionary
- Find repeatedly occurring suspected misrecognized words and build a correction mapping table.
- Include all variant forms of the same word.
- Use confidence: "low" when uncertain.
- Focus on proper nouns, IT/AI technical terms, and brand names.
- **Speaker-name misrecognitions must be included.**

### 4. Domain Terminology List
- Confirm correct Korean spelling with English in parentheses.

### 5. Content Genre Classification
Choose 1–2 from 7 types: 서사형, 설명형, 데모/도구활용형, 비교형, 산업/전략분석형, 역사+인물형, 기술트렌드형
Include per-segment genre transition detection.

### 6. Technical Difficulty
One of: 낮음 / 보통 / 높음 / 매우높음

## Output Format (JSON only — no other text)

{
  "overview": { "topic": "...", "keywords": ["..."] },
  "editorial_summary": {
    "one_liner": "이 인터뷰의 한 줄 요약",
    "key_points": ["핵심 논점 1", "핵심 논점 2", "핵심 논점 3"],
    "notable_quotes": [
      { "speaker": "화자명", "quote": "인상적인 발언 원문" }
    ],
    "editor_notes": "편집 시 참고사항"
  },
  "speakers": [{ "name": "화자명", "role": "역할" }],
  "term_corrections": [{ "wrong": "오인식", "correct": "올바른 표기", "confidence": "high" }],
  "domain_terms": [{ "term": "전문용어", "english": "English" }],
  "genre": {
    "primary": "설명형", "secondary": null,
    "transitions": [{ "block_range": [0, 25], "genre": "설명형" }]
  },
  "tech_difficulty": "높음",
  "audience_level": "관심 있는 비전문가"
}`;

async function handleAnalyze(body, env, headers) {
  const { full_text } = body;
  if (!full_text || full_text.length < 100) {
    return new Response(JSON.stringify({ error: "full_text가 너무 짧습니다 (최소 100자)" }), { status: 400, headers });
  }

  const userMsg = `Below is the full interview transcript. Perform the pre-analysis.\n\n---\n\n${full_text}`;
  const result = await callOpenAI(ANALYZE_PROMPT, userMsg, env, { temperature: 0.1, max_tokens: 8000 });

  if (result.error) return new Response(JSON.stringify({ error: result.error }), { status: result.status || 500, headers });
  return new Response(JSON.stringify({ success: true, analysis: result.content, usage: result.usage }), { headers });
}

// ═══════════════════════════════════════
// /highlights — 2-Pass: Draft Agent → Editor Agent
// ═══════════════════════════════════════

const DRAFT_AGENT_PROMPT = `당신은 인터뷰 영상의 강조자막 Draft Agent입니다.
강조자막 후보를 넉넉하게 생성하는 것이 목표입니다. 놓치지 않는 것이 최우선입니다.

## §1 핵심 원칙
자막은 녹취가 아니라 번역이다. 긴 구어체를 시청자가 바로 이해할 수 있는 단위로 번역하는 장치다.
단, 화자의 발언 자체가 핵심 콘텐츠인 경우 인용형으로 보존한다.
낯선 개념은 자막이 먼저 책임진다.
한 대목에는 한 가지 시청자 과제만 준다.
화면이 이미 충분하면 자막을 줄인다.
자막 밀도는 시간이 아니라 내용이 결정한다.

## §4 자막 유형 체계 (16유형)
### A. 핵심 전달 (~40%)
- A1. 핵심 논지 압축 (10~30자)
- A2. 핵심 메시지 인용 (따옴표, 15~80자)
- A3. 비유형 압축 (15~30자)
### B. 정의·설명 (~15%)
- B1. 등호 정의형 A = B (10~30자)
- B2. 용어 설명형 A : 설명 (40~150자, 40자 규칙 예외)
  트리거: 전문 용어 첫 등장, 모르면 이해 불가, 영문 약어
- B3. 인물 소개형 (30~100자)
### C. 구조화 (~15%)
- C1. 질문 프레이밍형
- C2. 목차/프레임워크형
- C3. 서사 프레이밍
- C4. 단계 분해형 ①②③
- C5. 프로세스 연쇄형 (인과 사슬)
### D. 평가·반응 (~10%)
- D1. 비교 평가형
- D2. 리액션형
- D3. 말풍선형
### E. 기능·실무 (~10%)
- E1. 기능 헤드라인
- E2. 실무 팁/행동 지침

## §5 문체 규칙
짧게, 단정적으로, 구어체 제거, 결론만. 명사·동사 중심.
대부분 40자 이내. B2(40~150자), B3(30~100자), A2(~80자) 예외.
시각 기호: →, ↑, ↓, ×, · / 두 줄 시 / 로 구분.

## §6 결정 트리
1. 시청자 메시지 있는가? → 없으면 스킵
2. 화면이 이미 전달? → 스킵
3. 어떤 유형? → 메시지 성격으로 선택
4. 직전 자막과 유형 중복? → 3연속 시 재조정

## 출력 지시
- 필요량의 1.5~2배 넉넉히 생성
- 놓칠 바에는 포함. Editor Agent가 걸러냄
- 낯선 용어 첫 등장 → 반드시 B2 후보 생성

반드시 JSON만 출력:
{
  "highlights": [{
    "block_index": 16, "speaker": "화자명",
    "source_text": "원문 일부 (50자 이내)",
    "subtitle": "코드 = 정형 언어 vs 프롬프트 = 비정형 언어",
    "type": "B1", "type_name": "등호 정의형",
    "reason": "설명", "placement_hint": null, "sequence_id": null
  }]
}

## 절대 규칙
1. 교정된 용어 사용  2. 구어체 금지  3. block_index 정확히  4. JSON만 출력`;


const EDITOR_AGENT_PROMPT = `당신은 인터뷰 영상의 강조자막 Editor Agent입니다.
Draft Agent가 생성한 후보를 검증·선별·다듬는 것이 목표입니다.

## §1 핵심 원칙
자막은 녹취가 아니라 번역이다. 한 대목에는 한 가지 과제만.
화면이 충분하면 줄인다. 밀도는 내용이 결정한다.

## §5 문체 규칙
짧게, 단정적, 구어체 제거. 40자 이내 (B2/B3/A2 예외).

## §7 스킵 조건
배경 설명/인사/도입, 농담, 단독 리액션, 반복, 전환 멘트, 잡담, 시연 화면 충분 구간

## §8 배치 지시
크기:(<<작게), 위치:(○○ 옆에), 톤:(부드러운), 이어붙이기:(위에꺼 이어서)

## §9 검증 체크리스트
번역인가? 구어체 남았는가? 1~2초 내 이해? 유일한 과제? 장르 적합? 유형 중복? 용어 설명 누락? 억지?

## 편집 작업
1. 스킵 조건 해당 → 제거
2. 유형 3연속 중복 → 재조정
3. 문체 다듬기
4. 장르별 밀도 조절
5. 놓친 B2 추가

## 출력 (JSON만)
{
  "highlights": [...],
  "removed": [{ "block_index": 5, "reason": "도입부 인사" }],
  "stats": { "draft_count": 45, "final_count": 28, "removal_rate": "38%" }
}

## 절대 규칙
1. 교정된 용어  2. 구어체 금지  3. block_index 정확  4. JSON만  5. removed에 사유 기록`;


const GENRE_DENSITY_STRATEGIES = {
  "서사형": `## 장르: 서사형\n밀도: 낮음. 인용형, 태도 강조 위주.`,
  "설명형": `## 장르: 설명형\n밀도: 높음. 개념마다 검토. 낯선 용어 반드시 B2.`,
  "데모/도구활용형": `## 장르: 데모형\n밀도: 가변. 시연 중 축소, 토킹헤드 복귀 시 복구.`,
  "비교형": `## 장르: 비교형\n밀도: 보통. 비교 근거 명확한 자막 위주.`,
  "산업/전략분석형": `## 장르: 산업/전략\n밀도: 매우 높음. 논점 전환마다 자막.`,
  "역사+인물형": `## 장르: 역사+인물\n밀도: 보통~높음.`,
  "기술트렌드형": `## 장르: 기술트렌드\n밀도: 높음.`,
};

function buildEditorPrompt(analysis) {
  let prompt = EDITOR_AGENT_PROMPT;
  if (analysis?.genre?.primary) {
    const s = GENRE_DENSITY_STRATEGIES[analysis.genre.primary];
    if (s) prompt += `\n\n${s}`;
  }
  if (analysis?.genre?.secondary) {
    const s2 = GENRE_DENSITY_STRATEGIES[analysis.genre.secondary];
    if (s2) prompt += `\n\n### 보조 장르\n${s2}`;
  }
  if (analysis?.tech_difficulty) {
    prompt += `\n\n## 기술 난이도: ${analysis.tech_difficulty}`;
    if (["높음","매우높음"].includes(analysis.tech_difficulty)) prompt += `\nB2 비중을 높이세요.`;
  }
  return prompt;
}

async function handleHighlights(body, env, headers) {
  const { mode, blocks, corrected_text, analysis, draft_highlights, chunk_index, total_chunks, target_block_indices, max_items } = body;
  if (mode === "draft") return await handleDraft(blocks, corrected_text, analysis, env, headers, chunk_index, total_chunks, target_block_indices, max_items);
  else if (mode === "edit") return await handleEdit(blocks, corrected_text, analysis, draft_highlights, env, headers, chunk_index, total_chunks);
  else return await handleDraft(blocks, corrected_text, analysis, env, headers, chunk_index, total_chunks, target_block_indices, max_items);
}

async function handleDraft(blocks, corrected_text, analysis, env, headers, chunk_index, total_chunks, target_block_indices, max_items) {
  let systemPrompt = DRAFT_AGENT_PROMPT;

  if (analysis?.genre) {
    systemPrompt += `\n\n## Step 0 분석 결과\n장르: ${analysis.genre.primary}${analysis.genre.secondary ? ` + ${analysis.genre.secondary}` : ""}`;
    if (analysis.genre.transitions?.length > 0) {
      systemPrompt += `\n장르 전환:`;
      for (const t of analysis.genre.transitions) systemPrompt += `\n- 블록 ${t.block_range[0]}~${t.block_range[1]}: ${t.genre}`;
    }
  }
  if (analysis?.tech_difficulty) systemPrompt += `\n기술 난이도: ${analysis.tech_difficulty}`;
  if (analysis?.domain_terms?.length > 0) {
    systemPrompt += `\n\n## 도메인 전문용어`;
    for (const dt of analysis.domain_terms) systemPrompt += `\n- ${dt.term} (${dt.english})`;
  }
  if (chunk_index !== undefined && total_chunks !== undefined) {
    systemPrompt += `\n\n## 청크 정보\n청크 ${chunk_index+1}/${total_chunks}.`;
    if (chunk_index > 0) systemPrompt += ` 앞 청크에서 이미 자막 생성됨. 이 청크 내용에 집중.`;
  }

  if (target_block_indices && Array.isArray(target_block_indices) && target_block_indices.length > 0) {
    const rangeLabel = target_block_indices.length === 1
      ? `블록 #${target_block_indices[0]}`
      : `블록 #${target_block_indices[0]}~#${target_block_indices[target_block_indices.length-1]}`;
    systemPrompt += `\n\n## 부분 생성 모드\n사용자가 ${rangeLabel}을 선택했습니다. 이 블록들의 내용을 종합적으로 분석하여 강조자막을 생성하세요.\n- 선택된 블록들의 전체 맥락을 하나로 이해한 뒤 자막을 만드세요.\n- 주변 블록은 맥락 참조용으로만 사용하고, 자막은 반드시 선택 블록(${target_block_indices.join(', ')})에만 배치하세요.`;
    if (max_items) {
      systemPrompt += `\n- 최대 ${max_items}개만 생성하세요. 가장 임팩트 있는 것만 엄선하세요.`;
    }
  }

  let userMsg = target_block_indices ? "아래는 선택 구간과 주변 맥락입니다. 선택 블록에 대해서만 강조자막을 생성하세요.\n\n" : "아래는 인터뷰 원고입니다. 강조자막 후보를 넉넉히 생성하세요.\n\n";
  if (blocks && Array.isArray(blocks)) {
    const targetSet = target_block_indices ? new Set(target_block_indices) : null;
    for (const b of blocks) {
      const marker = targetSet && targetSet.has(b.index) ? "★" : "";
      userMsg += `[블록 ${b.index}]${marker} ${b.speaker} ${b.timestamp}\n${b.text}\n\n`;
    }
  } else { userMsg += corrected_text || ""; }

  const result = await callOpenAI(systemPrompt, userMsg, env, { temperature: 0.3, max_tokens: 16000 });
  if (result.error) return new Response(JSON.stringify({ error: result.error }), { status: result.status||500, headers });
  return new Response(JSON.stringify({ success: true, result: result.content, usage: result.usage }), { headers });
}

async function handleEdit(blocks, corrected_text, analysis, draftHighlights, env, headers, chunk_index, total_chunks) {
  const systemPrompt = buildEditorPrompt(analysis);

  let userMsg = `Draft Agent가 생성한 강조자막 후보입니다. 검증·선별·다듬기를 수행하세요.\n\n`;
  userMsg += `## Draft 후보 (${draftHighlights.length}건)\n\n${JSON.stringify(draftHighlights, null, 2)}`;
  userMsg += `\n\n## 원문 참조\n\n`;
  if (blocks && Array.isArray(blocks)) {
    for (const b of blocks) userMsg += `[블록 ${b.index}] ${b.speaker} ${b.timestamp}\n${b.text}\n\n`;
  } else { userMsg += corrected_text || ""; }
  if (chunk_index !== undefined && total_chunks !== undefined) userMsg += `\n(청크 ${chunk_index+1}/${total_chunks})`;

  const result = await callOpenAI(systemPrompt, userMsg, env, { temperature: 0.2, max_tokens: 16000 });
  if (result.error) return new Response(JSON.stringify({ error: result.error }), { status: result.status||500, headers });
  return new Response(JSON.stringify({ success: true, result: result.content, usage: result.usage }), { headers });
}

// ═══════════════════════════════════════
// /term-explain — 용어 설명 자동 생성
// ═══════════════════════════════════════

async function handleTermExplain(body, env, headers) {
  const { term, context } = body;
  if (!term) return new Response(JSON.stringify({ error: "term is required" }), { status: 400, headers });

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ error: "GEMINI_API_KEY not configured." }), { status: 500, headers });

  const prompt = `당신은 영상 강조자막용 용어 설명 작성 전문가입니다.
주어진 용어에 대해 시청자가 바로 이해할 수 있는 1~2줄 짜리 설명을 생성하세요.

## 형식
용어(영문 원어) : 일상 언어로 풀어쓴 정의

## 규칙
- 40~150자 사이
- 전문 용어를 일상 언어로 번역
- 일상 비유를 포함하면 이해도가 올라감
- 구어체 금지, 간결체로 작성
- 반드시 JSON만 출력: { "explanation": "생성된 설명" }

용어: ${term}${context ? `\n\n참고 맥락:\n${context}` : ""}`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 2000 },
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      return new Response(JSON.stringify({ error: `Gemini API error ${response.status}: ${errText}` }), { status: 502, headers });
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

    if (!text) {
      return new Response(JSON.stringify({ error: "Gemini returned empty response" }), { status: 502, headers });
    }

    let jsonStr = text.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();
    const braceStart = jsonStr.indexOf('{');
    const braceEnd = jsonStr.lastIndexOf('}');
    if (braceStart !== -1 && braceEnd !== -1) jsonStr = jsonStr.substring(braceStart, braceEnd + 1);

    try {
      const result = JSON.parse(jsonStr);
      return new Response(JSON.stringify({ success: true, result }), { headers });
    } catch {
      return new Response(JSON.stringify({ success: true, result: { explanation: text.trim() } }), { headers });
    }
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
  }
}
