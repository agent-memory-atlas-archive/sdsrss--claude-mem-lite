// lib/recall-shown.mjs — what one THREAD has already been shown once: the recall framing header
// and the full cite directive (injection budget C1 / C3, docs/audits/20261016-injection-budget-baseline.md).
//
// Both lines are the same text on every PreToolUse / PostToolUse recall block. On the frozen
// 52-session corpus the header alone was 2.78 KB/session over 1,546 blocks and the Read→Edit
// nudge carrying the full directive 2.03 KB/session over 340 — while a thread needs each line
// once to know what the `[mem]` blocks are and how to tag a lesson. So the first block of a
// thread carries both in full, later blocks drop the header and carry a short directive that
// keeps the tag rule. Lesson rows are never touched here: every `#NN` that was injected still
// is, so the (session, id) pairs the cite-rate counts do not move.
//
// The marker is keyed like the cooldown (lib/cooldown-path.mjs threadKey): a subagent thread
// shares no context with its parent, so it gets its own header. SessionStart(compact) clears the
// main thread's marker, because compaction is when the earlier copy leaves the context.
//
// Leaf on purpose: scripts/pre-tool-recall.js is a hot standalone hook and imports this.
//
// Switches (each restores the old behaviour on its own):
//   CLAUDE_MEM_RECALL_HEADER_ONCE=0   header on every block
//   CLAUDE_MEM_DIRECTIVE_ONCE=0       full directive on every block

import { readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { atomicWriteFileSync } from './atomic-write.mjs';
import { cooldownSessionKey } from './cooldown-path.mjs';

/** Filename prefix, exported so the SessionStart GC can match the family. */
export const RECALL_SHOWN_PREFIX = 'recall-shown-';

// The default salience arm's directive (D#98). Moved here from scripts/pre-tool-recall.js, byte
// for byte, so benchmark/injection-budget.mjs can recognise it in recorded blocks.
export const ACK_DIRECTIVE =
  'apply each lesson to this edit or rule it out. If one changes the edit, add its bare tag (#NN) once at the end of the sentence describing that change; a lesson that did not apply needs no mention, and memory ids get no other mention in your reply.';
// What later blocks of the same thread carry. It keeps the one rule a cite depends on (tag only
// a lesson that changed the edit) and points back at the full text, which this thread has
// already been shown — the marker is cleared on compaction precisely so that stays true.
export const ACK_DIRECTIVE_SHORT =
  'apply each lesson to this edit — tag rule as before: (#NN) only where one changes it.';

const OFF = ['0', 'off', 'false', 'no'];
const isOn = (v) => !OFF.includes(String(v ?? '').toLowerCase());

const EMPTY = Object.freeze({ header: false, directive: false });

/**
 * Decide what one recall block shows, given what the thread was already shown.
 *
 * @param {{header: boolean, directive: boolean}} shown
 * @param {{header: boolean, directive: boolean}} wants  what the block would carry today
 * @param {Record<string, string|undefined>} [env]
 * @returns {{header: boolean, directive: 'full'|'short'|null, next: {header: boolean, directive: boolean}}}
 */
export function planRecallBlock(shown, wants, env = process.env) {
  const s = shown || EMPTY;
  const header = Boolean(wants?.header) && (!isOn(env.CLAUDE_MEM_RECALL_HEADER_ONCE) || !s.header);
  let directive = null;
  if (wants?.directive) directive = isOn(env.CLAUDE_MEM_DIRECTIVE_ONCE) && s.directive ? 'short' : 'full';
  return {
    header,
    directive,
    next: { header: Boolean(s.header || header), directive: Boolean(s.directive || directive === 'full') },
  };
}

/**
 * @param {string} runtimeDir
 * @param {string|null|undefined} thread  threadKey(sessionId, agentId); null without a session
 * @returns {string|null}
 */
export function recallShownPath(runtimeDir, thread) {
  if (!thread) return null;
  return join(runtimeDir, `${RECALL_SHOWN_PREFIX}${cooldownSessionKey(thread)}.json`);
}

/** @returns {{header: boolean, directive: boolean}} empty when absent, unreadable or no path */
export function readRecallShown(path) {
  if (!path) return { ...EMPTY };
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'));
    return { header: v?.header === true, directive: v?.directive === true };
  } catch {
    return { ...EMPTY };
  }
}

/** Best-effort write; a lost write only means the next block shows the line again. */
export function markRecallShown(path, shown) {
  if (!path) return;
  try {
    atomicWriteFileSync(
      path,
      JSON.stringify({ header: Boolean(shown?.header), directive: Boolean(shown?.directive) }),
    );
  } catch {
    /* silent — never block a tool call over a marker */
  }
}

/** SessionStart(compact): the main thread's earlier copies are gone from the context. */
export function clearRecallShown(runtimeDir, sessionId) {
  const p = recallShownPath(runtimeDir, sessionId);
  if (!p) return;
  try {
    unlinkSync(p);
  } catch {
    /* absent is fine */
  }
}
