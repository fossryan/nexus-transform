'use strict';
// Local stand-in for the Messages API that enforces the Sonnet 5.5 rules that broke v1:
// no forced tool_choice, no sampling params, adaptive thinking blocks in responses.
const http = require('node:http');
const port = Number(process.argv[2] || 8111);
const GOOD = "SELECT\n  ticker,\n  revenue\nFROM annual_financials\nWHERE calendar_year = 2024\nORDER BY revenue DESC\nLIMIT 5";
const BROKEN = "SELECT\n  ticker,\n  revenue_total\nFROM annual_financials\nLIMIT 5";
const log = [];

http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const body = JSON.parse(b);
    const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/__log') return send(200, log);
    const msgs = body.messages;
    const last = msgs[msgs.length - 1];
    const lastText = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
    log.push({ tool_choice: body.tool_choice, turns: msgs.length, last: lastText.slice(0, 80) });
    if (!req.headers['x-api-key']) return send(401, { type: 'error', error: { type: 'authentication_error', message: 'missing key' } });
    if (body.tool_choice && ['tool', 'any'].includes(body.tool_choice.type)) {
      return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'tool_choice: type "tool" and "any" are not supported for this model.' } });
    }
    if ('temperature' in body) return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'temperature not supported' } });
    // Replayed assistant turns must keep their thinking block.
    for (const m of msgs) {
      if (m.role === 'assistant' && Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_use') && !m.content.some((c) => c.type === 'thinking' && c.signature === 'sig')) {
        return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'assistant turn with tool_use must include its thinking block' } });
      }
    }
    const thinking = { type: 'thinking', thinking: 'Considering the schema…', signature: 'sig' };
    if (!Array.isArray(body.system) || !body.system[0].cache_control) return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'test expects a cached system block' } });
    if (body.tools[0].name === 'explain_results') {
      return send(200, { content: [thinking, { type: 'tool_use', id: `toolu_x${log.length}`, name: 'explain_results', input: { headline: 'Fake headline', findings: [{ text: 'Finding one' }], caveats: ['Caveat'] } }], stop_reason: 'tool_use' });
    }
    const first = msgs.length === 1;
    if (first && /prose/.test(lastText)) {
      return send(200, { content: [thinking, { type: 'text', text: 'Here is some SQL in prose.' }], stop_reason: 'end_turn' });
    }
    const repairing = /rejected this query/.test(lastText);
    const wantBroken = /broken/.test(JSON.stringify(msgs[0].content)) && !repairing;
    const input = {
      title: 'Top 5 by revenue', summary: 'Five largest companies by 2024 revenue.', sql: wantBroken ? BROKEN : GOOD,
      confidence: 84, confidence_reason: 'Calendar vs fiscal year.', assumptions: [{ line: 5, note: 'Calendar year 2024, not fiscal.', severity: 'verify' }],
    };
    send(200, { content: [thinking, { type: 'tool_use', id: `toolu_${log.length}`, name: 'propose_transformation', input }], stop_reason: 'tool_use', usage: { input_tokens: 3000, output_tokens: 400 } });
  });
}).listen(port, () => console.log(`fake anthropic on ${port}`));
