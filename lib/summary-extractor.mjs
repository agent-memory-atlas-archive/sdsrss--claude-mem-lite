// Structured summary extractor: reads the tail assistant message from a
// Claude Code transcript and pulls out Done / Not done / Failed / Uncertain
// sections using deterministic markers. This is the non-Haiku path — the
// markers are enforced by CLAUDE.md §10's four-section order rule, so they
// appear in ~every end-of-task message.
//
// Haiku summarization remains the richer best-effort enrichment, but it
// silently fails ~66% of Stop events in practice, leaving session_summaries
// with empty remaining_items. This extractor runs synchronously in
// handleStop and gives a deterministic floor.

import { readTranscriptEntries } from './transcript-scan.mjs';

const EN_HEADER =
  /^[\s●*>-]*(?:(Done|Not\s+done|Failed|Uncertain)\s*[:：]|\*\*(Done|Not\s+done|Failed|Uncertain)\*\*\s*(?:[:：]|[—–]|-(?=\s)))\s*/im;
const ZH_HEADER = /^[\s●*>-]*(剩下的?|剩余|还剩|未完成|下次(?:要做|做|继续)?|待做|未做)\s*[:：]?\s*/m;

// A section heading that IS the whole line — \`## Done\`, \`**Not done**\`, \`**Done:**\`,
// \`**Uncertain.**\`. 362 of 440 turn-final reports on this machine (2026-09-26) used one; the
// colon form above caught 78. Its body runs through blank lines, paragraphs and tables up to
// the next heading or rule (BLOCK_END), not to the first paragraph break. A standalone bold
// line ends it too, but only once the section has content: reports open a section with a
// bold lead sentence (\`## Done\` / \`**4 rounds, 3 defects fixed.**\`) as often as they
// start an unrelated block with a bold title after it.
const BLOCK_HEADER =
  /^\s*(?:#{1,6}\s+(?:\*\*)?|\*\*)\s*(Done|Not\s+done|Failed|Uncertain)\s*[:：.]?\s*(?:\*\*)?\s*[:：]?\s*$/i;
const BLOCK_END = /^\s*(?:#{1,6}\s|(?:-{3,}|\*{3,}|_{3,})\s*$)/;
const BOLD_LINE = /^\s*\*\*[^*].*\*\*[:：]?\s*$/;

// Recognised section keys, normalised.
const EN_KEY = { done: 'done', 'not done': 'notDone', failed: 'failed', uncertain: 'uncertain' };
const ZH_KEY_IS_NOTDONE = /剩下|剩余|还剩|未完成|下次|待做|未做/;

/**
 * Read the LAST assistant text block from a Claude Code transcript .jsonl.
 * Returns concatenated text of all text blocks in the last `type='assistant'`
 * entry, or null if the file is missing/empty/malformed.
 *
 * @param {string} transcriptPath
 * @returns {string|null}
 */
export function extractTailAssistantText(transcriptPath) {
  let last = null;
  for (const entry of readTranscriptEntries(transcriptPath)) {
    if (entry.type !== 'assistant' || !entry.message) continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    const texts = content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text);
    if (texts.length === 0) continue;
    last = texts.join('\n');
  }
  return last;
}

/**
 * Extract Done / Not done / Failed / Uncertain sections from a message body.
 * Returns an object with four string fields (empty when the section is absent).
 *
 * Strategy: scan line by line, recognise section headers in EN and 中文,
 * attribute subsequent content to that section until the next header or a
 * hard boundary (blank line followed by a non-bullet line).
 *
 * @param {string} text
 * @returns {{done: string, notDone: string, failed: string, uncertain: string}}
 */
export function extractStructuredSummary(text) {
  const out = { done: '', notDone: '', failed: '', uncertain: '' };
  if (!text || typeof text !== 'string') return out;

  const lines = text.split('\n');
  let current = null;
  let block = false;
  const buffers = { done: [], notDone: [], failed: [], uncertain: [] };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    const blockMatch = line.match(BLOCK_HEADER);
    if (blockMatch) {
      current = EN_KEY[blockMatch[1].toLowerCase().replace(/\s+/g, ' ')];
      block = true;
      continue;
    }

    // Header detection — EN first (unambiguous), then 中文. An inline header (\`Failed: none\`,
    // \`**Failed:** 无。\`) also ends a block section.
    const enMatch = line.match(EN_HEADER);
    if (enMatch) {
      const key = EN_KEY[(enMatch[1] || enMatch[2]).toLowerCase().replace(/\s+/g, ' ')];
      if (key) {
        current = key;
        block = false;
        const tail = line
          .slice(enMatch[0].length)
          .replace(/^\*\*\s*/, '')
          .trim();
        if (tail) buffers[current].push(tail);
        continue;
      }
    }
    if (block && current) {
      if (BLOCK_END.test(line) || (BOLD_LINE.test(line) && buffers[current].length > 0)) {
        current = null;
        block = false;
      } else if (trimmed) {
        buffers[current].push(trimmed);
        continue;
      } else continue;
    }
    const zhMatch = line.match(ZH_HEADER);
    if (zhMatch && ZH_KEY_IS_NOTDONE.test(zhMatch[1])) {
      current = 'notDone';
      const tail = line.slice(zhMatch[0].length).trim();
      if (tail) buffers.notDone.push(tail);
      continue;
    }

    if (!current) continue;

    // Paragraph-break termination: blank line followed by a non-bullet,
    // non-indented line starts a fresh paragraph unrelated to the section.
    if (!trimmed) {
      const next = (lines[i + 1] || '').trim();
      const nextIsBullet = /^[-*•●\d]+[.)]?\s+/.test(next);
      if (!nextIsBullet && next) {
        current = null;
      }
      continue;
    }

    buffers[current].push(trimmed);
  }

  for (const k of Object.keys(buffers)) {
    out[k] = buffers[k].join('\n').trim();
  }
  return out;
}
