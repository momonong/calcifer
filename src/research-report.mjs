import { fail } from './workspace-tools.mjs';

// Model-proposed facts are short excerpts. The host supplies source links.
export function renderResearchReport({ question, text, sources, runID }) {
  let proposal;
  try { proposal = JSON.parse(text); } catch { fail('RESEARCH_REPORT_INVALID'); }
  if (!Array.isArray(proposal?.findings) || !proposal.findings.length || proposal.findings.length > 8) {
    fail('RESEARCH_REPORT_INVALID');
  }
  const byId = new Map(sources.map(source => [source.id, source]));
  const used = new Set();
  const findings = proposal.findings.map(finding => {
    const source = byId.get(finding?.sourceId);
    const excerpt = finding?.excerpt;
    if (!source || typeof excerpt !== 'string' || excerpt.length < 12 || excerpt.length > 300
      || !source.text.includes(excerpt)) fail('RESEARCH_CITATION_MISMATCH');
    used.add(source.id);
    return '- ' + escapeText(excerpt) + ' [' + source.id + ']';
  });
  const cited = sources.filter(source => used.has(source.id));
  if (!cited.some(source => source.kind === 'web_fetch') || !cited.some(source => source.kind === 'mcp_read')) {
    fail('RESEARCH_EVIDENCE_INCOMPLETE');
  }
  const recommendation = proposal.recommendation;
  if (typeof recommendation?.text !== 'string' || !recommendation.text.trim() || recommendation.text.length > 500
    || /[\r\n]|(?:[a-z][a-z0-9+.-]*:\/\/)|(?:\bwww\.)/i.test(recommendation.text)
    || !Array.isArray(recommendation.sourceIds)
    || recommendation.sourceIds.length !== used.size || new Set(recommendation.sourceIds).size !== used.size
    || recommendation.sourceIds.some(id => !used.has(id))) fail('RESEARCH_REPORT_INVALID');
  return [
    '# 研究報告',
    '',
    '**離線驗收資料。** 摘錄與工具回覆來自合成 fixture。',
    '',
    '## 研究問題',
    '',
    escapeText(question),
    '',
    '## 查核結果',
    '',
    ...findings,
    '',
    '## 建議（模型推論）',
    '',
    escapeText(recommendation.text),
    '',
    '模型選用的資料 ' + recommendation.sourceIds.map(id => '[' + id + ']').join(' '),
    '',
    '## 來源',
    '',
    ...cited.map(source => '- [' + source.id + '] [' + escapeText(source.title) + '](' + source.url + ')'
      + '，' + (source.kind === 'web_fetch' ? '網頁正文' : '唯讀 MCP') + ' fixture，取得時間 ' + source.retrievedAt),
    '',
    '執行識別碼 ' + runID,
    ''
  ].join('\n');
}

function escapeText(value) {
  return value.replace(/\s+/g, ' ').replace(/[\\&<>\[\]()!_*\x60|#]/g, '\\$&');
}
