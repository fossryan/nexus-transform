'use strict';
// Natural language → SQL with Claude. The model must answer through a tool so the
// response is structured: SQL plus line-level assumptions and a self-reported confidence.

const API_URL = `${process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'}/v1/messages`;

const TOOL = {
  name: 'propose_transformation',
  description: 'Return the SQL transformation for the analyst to review, with every assumption you made tied to a SQL line.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short name for this transformation, 3–7 words, e.g. "Top 10 by 2024 revenue".' },
      summary: { type: 'string', description: 'Plain-English explanation for a non-technical financial analyst: what the result contains and how it is calculated. 1–3 sentences, no SQL jargon.' },
      sql: { type: 'string', description: 'A single SQLite SELECT (may start with WITH). Put each clause, selected column and join on its own line so assumptions can point at lines. No trailing semicolon. Include a LIMIT of at most 500 unless the result is naturally small.' },
      confidence: { type: 'integer', minimum: 0, maximum: 100, description: 'How likely this SQL answers what the analyst meant. Lower it for every judgment call you had to make.' },
      confidence_reason: { type: 'string', description: 'One sentence: the main reason confidence is not higher.' },
      assumptions: {
        type: 'array',
        description: 'Every interpretation, default or data caveat the analyst should know about, attached to the SQL line it affects. Include caveats from the column notes when they matter (calendar vs fiscal year, missing values, units).',
        items: {
          type: 'object',
          properties: {
            line: { type: 'integer', description: '1-based line number in the sql string.' },
            note: { type: 'string', description: 'What was assumed and what to check, under 160 characters, plain language.' },
            severity: { type: 'string', enum: ['info', 'verify', 'risk'], description: 'info = harmless default; verify = could change the answer, analyst should confirm; risk = likely to mislead if wrong.' },
          },
          required: ['line', 'note', 'severity'],
        },
      },
      clarifying_question: { type: 'string', description: 'Only if the request is too ambiguous to answer well: one question to ask the analyst. Still return your best-guess SQL.' },
    },
    required: ['title', 'summary', 'sql', 'confidence', 'confidence_reason', 'assumptions'],
  },
};

function systemPrompt(schemaText) {
  return [
    'You turn a financial analyst\'s plain-English request into a SQLite query over the dataset below.',
    'The analyst cannot read SQL well. They will decide to accept, edit or reject your query based on your summary and assumptions, so be candid about every judgment call.',
    '',
    'Rules:',
    `- Always answer by calling the ${TOOL.name} tool, never in plain text. If the request is ambiguous, still call the tool with your best guess and put your question in clarifying_question.`,
    '- SQLite dialect only. Read-only: a single SELECT or WITH … SELECT.',
    '- Use only tables and columns that exist below. Prefer the annual_financials view for company fundamentals.',
    '- Write one clause, selected column or join per line; line numbers in assumptions must match.',
    '- Give result columns readable snake_case aliases. Round ratios and percentages to 2 decimals; keep currency in whole dollars unless the request asks otherwise.',
    '- Guard divisions with NULLIF to avoid divide-by-zero.',
    '- If the request names a year that is not in the data range, use the closest available year and say so as a "risk" assumption.',
    '- Confidence is about matching the analyst\'s intent, not about SQL syntax. Do not exceed 90 when you made a "verify" assumption, or 70 with a "risk" one.',
    '',
    'DATASET',
    schemaText,
  ].join('\n');
}

function normalize(input) {
  const sql = String(input.sql || '').replace(/\r\n/g, '\n').trim().replace(/;\s*$/, '');
  const lineCount = sql.split('\n').length;
  const assumptions = (Array.isArray(input.assumptions) ? input.assumptions : [])
    .filter((a) => a && typeof a.note === 'string' && a.note.trim())
    .map((a) => ({
      line: Math.min(Math.max(1, parseInt(a.line, 10) || 1), lineCount),
      note: a.note.trim().slice(0, 240),
      severity: ['info', 'verify', 'risk'].includes(a.severity) ? a.severity : 'verify',
    }))
    .sort((a, b) => a.line - b.line);
  return {
    title: String(input.title || 'Untitled transformation').slice(0, 80),
    summary: String(input.summary || '').slice(0, 600),
    sql,
    confidence: Math.min(100, Math.max(0, parseInt(input.confidence, 10) || 0)),
    confidenceReason: String(input.confidence_reason || '').slice(0, 240),
    assumptions,
    clarifyingQuestion: input.clarifying_question ? String(input.clarifying_question).slice(0, 240) : null,
  };
}

function createAI({ apiKey, model, mock }) {
  async function call({ schemaText, messages }) {
    if (mock) return mockAnswer(messages);
    // Newer models (e.g. Sonnet 5.5) reject tool_choice "tool"/"any", so the tool is offered
    // with "auto" and the system prompt requires it. If the model answers in prose anyway,
    // we ask once more within the same conversation.
    let convo = messages;
    for (let attempt = 0; attempt < 2; attempt++) {
      const body = await post(convo, schemaText);
      const content = body.content || [];
      const block = content.find((b) => b.type === 'tool_use' && b.name === TOOL.name);
      if (block) {
        return { proposal: normalize(block.input), toolUseId: block.id, rawInput: block.input, assistantContent: content, messages: convo, usage: body.usage || null };
      }
      if (body.stop_reason === 'max_tokens') throw new Error('Claude ran out of room before finishing the SQL. Try a narrower request.');
      convo = [...convo, { role: 'assistant', content }, { role: 'user', content: `Respond only by calling the ${TOOL.name} tool.` }];
    }
    throw new Error('Claude did not return a transformation.');
  }

  async function post(messages, schemaText) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 8000, // room for adaptive thinking plus the tool call
        system: systemPrompt(schemaText),
        tools: [TOOL],
        tool_choice: { type: 'auto' },
        messages,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (body.error && body.error.message) || res.statusText;
      const err = new Error(`Claude API error ${res.status}: ${msg}`);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  // prompt: analyst request. base: optional {sql, prompt} when refining an existing transformation.
  async function propose({ schemaText, prompt, base }) {
    const content = base
      ? `Current transformation (originally requested as: "${base.prompt}"):\n\`\`\`sql\n${base.sql}\n\`\`\`\n\nRevise it: ${prompt}`
      : prompt;
    return call({ schemaText, messages: [{ role: 'user', content }] });
  }

  // Ask the model to fix SQL that failed validation, continuing the same conversation.
  // The assistant turn is replayed exactly as returned (thinking blocks included).
  async function repair({ schemaText, messages, toolUseId, rawInput, assistantContent, error }) {
    const convo = [
      ...messages,
      { role: 'assistant', content: assistantContent || [{ type: 'tool_use', id: toolUseId, name: TOOL.name, input: rawInput }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: true, content: `SQLite rejected this query: ${error}\nReturn a corrected transformation. Keep the same intent.` }] },
    ];
    return call({ schemaText, messages: convo });
  }

  return { propose, repair, model: mock ? 'mock (not Claude)' : model, mock: !!mock };
}

// ---- Mock used only for offline tests (MOCK_AI=1). The UI shows a banner when it is on. ----
let mockCalls = 0;
function mockAnswer(messages) {
  mockCalls++;
  const last = messages[messages.length - 1];
  const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
  let input;
  if (/rejected this query/.test(text)) {
    input = {
      title: 'Top companies by revenue', summary: 'Largest companies by revenue in the latest full year, with net margin.',
      sql: "SELECT\n  ticker,\n  name,\n  revenue,\n  ROUND(100.0 * net_income / NULLIF(revenue, 0), 2) AS net_margin_pct\nFROM annual_financials\nWHERE calendar_year = (SELECT MAX(calendar_year) FROM annual_financials)\n  AND revenue IS NOT NULL\nORDER BY revenue DESC\nLIMIT 10",
      confidence: 78, confidence_reason: 'Repaired after a column-name error.',
      assumptions: [{ line: 7, note: 'Uses the latest calendar year in the data, not fiscal year.', severity: 'verify' }],
    };
  } else if (/broken/i.test(text)) {
    input = { title: 'Broken on purpose', summary: 'Test of repair loop.', sql: 'SELECT\n  ticker,\n  revenue_total\nFROM annual_financials\nLIMIT 5', confidence: 80, confidence_reason: 'test', assumptions: [] };
  } else if (/spread|yield|treasury/i.test(text)) {
    input = {
      title: '10Y–2Y spread by month', summary: 'Average monthly gap between the 10-year and 2-year Treasury yields; negative means the curve is inverted.',
      sql: "WITH daily AS (\n  SELECT\n    a.obs_date,\n    a.value - b.value AS spread\n  FROM econ_observations a\n  JOIN econ_observations b ON b.obs_date = a.obs_date AND b.series_id = 'DGS2'\n  WHERE a.series_id = 'DGS10'\n)\nSELECT\n  substr(obs_date, 1, 7) AS month,\n  ROUND(AVG(spread), 2) AS avg_spread_pct,\n  CASE WHEN AVG(spread) < 0 THEN 'inverted' ELSE 'normal' END AS curve\nFROM daily\nGROUP BY month\nORDER BY month",
      confidence: 86, confidence_reason: 'Monthly averaging is a choice; month-end values would differ slightly.',
      assumptions: [
        { line: 6, note: 'Only days where both yields were published are compared.', severity: 'info' },
        { line: 10, note: 'Averages daily spreads within each month rather than using the month-end value.', severity: 'verify' },
      ],
    };
  } else {
    input = {
      title: 'Top companies by revenue', summary: 'Largest companies by revenue in the latest full year, with net margin.',
      sql: "SELECT\n  ticker,\n  name,\n  revenue,\n  ROUND(100.0 * net_income / NULLIF(revenue, 0), 2) AS net_margin_pct\nFROM annual_financials\nWHERE calendar_year = (SELECT MAX(calendar_year) FROM annual_financials)\n  AND revenue IS NOT NULL\nORDER BY revenue DESC\nLIMIT 10",
      confidence: 82, confidence_reason: 'Calendar-year frames may not match each company\'s fiscal year.',
      assumptions: [
        { line: 5, note: 'Net margin = net income ÷ revenue.', severity: 'info' },
        { line: 7, note: 'Uses the latest calendar year in the data, not fiscal year.', severity: 'verify' },
      ],
    };
  }
  const toolUseId = `mock_${mockCalls}`;
  return Promise.resolve({ proposal: normalize(input), toolUseId, rawInput: input, assistantContent: [{ type: 'tool_use', id: toolUseId, name: TOOL.name, input }], messages, usage: null });
}

module.exports = { createAI, normalize, TOOL, systemPrompt };
