#!/usr/bin/env node
/**
 * INJECTION BUDGET — what this plugin's hooks put in front of the model, per session, split
 * by FACE (which hook) and by LINE CLASS (which part of the block), read from real
 * transcripts over a FIXED corpus.
 *
 * WHY IT EXISTS. `citation-live-replay.mjs` prices each face by cite-rate; nothing priced
 * the other half of the trade, the bytes. A face can cite well and still cost more context
 * than it returns, and several line classes (the framing header, the file-info line, the
 * SessionStart dashboard) carry no `#NN` id at all, so no cite-rate can ever see them. This
 * ruler reads both halves off one walk.
 *
 * CORPUS — fixed, so an after-arm compares against the same sessions:
 *   population  = `<root>/<project>/<session>.jsonl` (session level, as citation-live-replay)
 *                 whose FIRST timestamp lies in [--since, --until), entrypoint `cli` only,
 *                 at least one typed main-thread prompt (`hookPromptOf` non-null, origin
 *                 human). Interactive sessions only: `claude -p` runs have no human in them.
 *   cut         = every record stamped at or after --until is dropped, so a session still
 *                 running when the corpus was frozen contributes only what it had by then.
 *   --freeze d  = write exactly that population (and each session's `subagents/` files, cut
 *                 the same way) to `d`, with a MANIFEST.json. Point every later run — this
 *                 ruler AND citation-live-replay — at it with CLAUDE_MEM_TRANSCRIPT_ROOT=d.
 *                 Claude Code deletes transcripts after 30 days and every live session grows
 *                 the corpus, so a number not read off a frozen root cannot be re-derived.
 *
 * CALIBER:
 *   bytes       = UTF-8 bytes of the model-visible text: `hookSpecificOutput.additionalContext`
 *                 when stdout is JSON, else raw stdout (SessionStart / UserPromptSubmit plain
 *                 stdout is context too). `systemMessage` is reported separately — Claude Code
 *                 shows it to the user as its own attachment. `updatedInput` (the subagent
 *                 prompt rewrite) goes to the SUBAGENT's context, not this one, and is counted
 *                 apart as `pretool_agent` added bytes.
 *   line bytes  = each line plus its newline, the last line without — so a block's classes sum
 *                 to the block exactly (`assertClassesSumToText`).
 *   per session = total / sessions in the population (sessions with zero injections count).
 *
 * VALUE PROXIES (`--value`), for the line classes no cite-rate can reach — each stated with
 * what it can and cannot show:
 *   file_info       what triggered the line (a full Read, a partial Read, a Bash read) and
 *                   whether a LATER call in the same turn sliced or grepped the same file, or
 *                   the model's text named its size. Delivery is next to the tool RESULT
 *                   (Claude Code hooks reference, "Add context for Claude"), so the line can
 *                   never change the call it rides on — only later ones.
 *   session_start   Recent / Key Context ids cited (`#NN`, shipped extractor) and Deferred
 *                   `D#N` named in main-thread text; the dashboard's `activity` hint run.
 *   past_questions  each `P#N` row: named by the model, and whether its text is an echo of
 *                   the prompt that triggered it or of an earlier prompt in the same session.
 *   handoff         sessions where the UserPromptSubmit handoff AND SessionStart's
 *                   Last Session / Working State sections were both injected.
 *
 * Cite-rates for the id-bearing faces come from `citation-live-replay.mjs` run on the same
 * frozen root; this file does not re-derive them (that would be a twin of SURFACE_MATCHERS).
 *
 *   node benchmark/injection-budget.mjs --since 2026-09-30 --until 2026-10-16 --freeze benchmark/results/injection-corpus-20261016
 *   CLAUDE_MEM_TRANSCRIPT_ROOT=benchmark/results/injection-corpus-20261016 node benchmark/injection-budget.mjs --value
 *   … --json
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import {
  OBS_ID_DIGITS,
  hookPromptOf,
  extractCitationsFromTranscript,
  findSubagentTranscripts,
} from '../lib/citation-tracker.mjs';
import { TASK_IMPERATIVE_PREFIX } from '../lib/task-imperative.mjs';
import { ACK_DIRECTIVE, ACK_DIRECTIVE_SHORT, planRecallBlock } from '../lib/recall-shown.mjs';
import { fileIntelEnabled } from '../lib/file-intel.mjs';
import { recentTableRowCap } from '../hook-context.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS_FORMAT = 'injection-budget/1';

const argv = process.argv.slice(2);
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : argv[i + 1];
};
const has = (flag) => argv.includes(flag);

// ─── 0. Which hook command is which face ─────────────────────────────────────

/**
 * This plugin's hook commands, by a substring of the quote-stripped command. Order matters
 * only where one mark contains another (`hook.mjs user-prompt` vs `user-prompt-search`):
 * the first match wins. Checked against the SHIPPED hooks/hooks.json on every run
 * (`assertHookTableCoversShippedWiring`), so a hook added there without a row here fails the
 * run instead of silently landing in `others`.
 */
export const MEM_HOOK_FACES = [
  { face: 'pretool', event: 'PreToolUse', mark: 'pre-tool-recall' },
  { face: 'pretool_agent', event: 'PreToolUse', mark: 'pre-agent-inject' },
  { face: 'session_start', event: 'SessionStart', mark: 'hook.mjs session-start' },
  { face: 'setup', event: 'SessionStart', mark: 'scripts/setup.sh' },
  { face: 'ups_search', event: 'UserPromptSubmit', mark: 'user-prompt-search' },
  { face: 'ups_context', event: 'UserPromptSubmit', mark: 'hook.mjs user-prompt' },
  { face: 'posttool', event: 'PostToolUse', mark: 'post-tool-use.sh' },
  { face: 'posttool_edit', event: 'PostToolUse', mark: 'post-tool-recall' },
  { face: 'posttool_failure', event: 'PostToolUseFailure', mark: 'hook.mjs post-tool-failure' },
  { face: 'pre_compact', event: 'PreCompact', mark: 'hook.mjs pre-compact' },
  { face: 'stop', event: 'Stop', mark: 'hook.mjs stop' },
];

const normalizeCommand = (c) => String(c || '').replace(/["']/g, '');

/** @returns {string|null} the face, or null when the command is not this plugin's. */
export function memFaceOf(event, command, table = MEM_HOOK_FACES) {
  const cmd = normalizeCommand(command);
  for (const row of table) {
    if (row.event === event && cmd.includes(row.mark)) return row.face;
  }
  return null;
}

/** Every command in the shipped hooks.json must map to exactly one face. */
export function assertHookTableCoversShippedWiring(
  hooksJson = JSON.parse(readFileSync(join(REPO, 'hooks', 'hooks.json'), 'utf8')),
  table = MEM_HOOK_FACES,
) {
  const problems = [];
  for (const [event, groups] of Object.entries(hooksJson.hooks || {})) {
    for (const g of groups) {
      for (const h of g.hooks || []) {
        const cmd = normalizeCommand(h.command);
        const hits = table.filter((r) => r.event === event && cmd.includes(r.mark));
        if (hits.length !== 1) problems.push(`${event}: ${h.command} → ${hits.length} faces`);
      }
    }
  }
  if (problems.length) {
    throw new Error(
      `hook table: every shipped hook must map to exactly one face — ${problems.join('; ')}. ` +
        'Add or narrow a MEM_HOOK_FACES row; an unmapped hook would be reported under others.',
    );
  }
}

/** Short label for a hook that is not this plugin's (for the `others` rows). */
function otherHookLabel(event, command) {
  const cmd = normalizeCommand(command);
  const m = cmd.match(/([\w.-]+\.(?:sh|js|mjs|cmd|py))(?:\s+([\w-]+))?/);
  return `${event}|${m ? m[1] + (m[2] ? ' ' + m[2] : '') : cmd.slice(0, 40)}`;
}

// ─── 1. Corpus ───────────────────────────────────────────────────────────────

function transcriptRoot() {
  return process.env.CLAUDE_MEM_TRANSCRIPT_ROOT || join(homedir(), '.claude', 'projects');
}

function listSessionFiles(root) {
  const out = [];
  let dirs = [];
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const d of dirs) {
    let names = [];
    try {
      names = readdirSync(join(root, d.name)).filter((n) => n.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const n of names.sort()) out.push({ project: d.name, path: join(root, d.name, n) });
  }
  return out;
}

/** Raw lines of a transcript with every record stamped at/after `until` dropped. */
export function cutLines(raw, until) {
  const keep = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // a partially written tail line
    }
    const t = Date.parse(o?.timestamp || '');
    if (Number.isFinite(until) && Number.isFinite(t) && t >= until) continue;
    keep.push({ line, entry: o });
  }
  return keep;
}

/**
 * Whether a session belongs to the population, and its start time.
 * @returns {{ok: boolean, start: number, prompts: number}}
 */
export function sessionVerdict(entries, since, until) {
  let start = NaN;
  let prompts = 0;
  const entrypoints = new Set();
  for (const e of entries) {
    if (!Number.isFinite(start)) {
      const t = Date.parse(e?.timestamp || '');
      if (Number.isFinite(t)) start = t;
    }
    if (e?.entrypoint) entrypoints.add(e.entrypoint);
    if (hookPromptOf(e) !== null && (e.origin?.kind ?? 'human') === 'human') prompts++;
  }
  const inWindow =
    Number.isFinite(start) &&
    (!Number.isFinite(since) || start >= since) &&
    (!Number.isFinite(until) || start < until);
  const cliOnly = [...entrypoints].every((x) => x === 'cli');
  return { ok: inWindow && cliOnly && prompts > 0, start, prompts };
}

function parseWhen(flag) {
  const v = argOf(flag);
  if (v === null) return NaN;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new Error(`${flag}: not a date: ${v}`);
  return t;
}

/** Load the population. Each session: its kept entries, raw lines, subagent files (cut). */
function loadCorpus(root, since, until) {
  const sessions = [];
  let files = 0;
  for (const { project, path } of listSessionFiles(root)) {
    files++;
    let raw;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const kept = cutLines(raw, until);
    const entries = kept.map((k) => k.entry);
    const v = sessionVerdict(entries, since, until);
    if (!v.ok) continue;
    sessions.push({
      project,
      path,
      session: basename(path, '.jsonl'),
      start: v.start,
      prompts: v.prompts,
      kept,
      entries,
    });
  }
  return { sessions, files };
}

function freeze(corpus, dir, meta) {
  const listing = [];
  for (const s of corpus.sessions) {
    const outDir = join(dir, s.project);
    mkdirSync(outDir, { recursive: true });
    const body = s.kept.map((k) => k.line).join('\n') + '\n';
    const target = join(outDir, `${s.session}.jsonl`);
    writeFileSync(target, body);
    listing.push({
      file: `${s.project}/${s.session}.jsonl`,
      bytes: Buffer.byteLength(body),
      sha256: sha(body),
    });
    for (const sub of findSubagentTranscripts(s.path)) {
      const subKept = cutLines(readFileSync(sub, 'utf8'), meta.until);
      if (!subKept.length) continue;
      const subDir = join(outDir, s.session, 'subagents');
      mkdirSync(subDir, { recursive: true });
      const subBody = subKept.map((k) => k.line).join('\n') + '\n';
      writeFileSync(join(subDir, basename(sub)), subBody);
      listing.push({
        file: `${s.project}/${s.session}/subagents/${basename(sub)}`,
        bytes: Buffer.byteLength(subBody),
        sha256: sha(subBody),
      });
    }
  }
  const manifest = {
    format: CORPUS_FORMAT,
    frozenAt: new Date().toISOString(),
    since: Number.isFinite(meta.since) ? new Date(meta.since).toISOString() : null,
    until: Number.isFinite(meta.until) ? new Date(meta.until).toISOString() : null,
    sourceRoot: meta.root,
    population:
      'session-level *.jsonl, first timestamp in [since, until), entrypoint cli only, >=1 typed human prompt; records >= until dropped',
    sessions: corpus.sessions.length,
    files: listing.length,
    listingSha256: sha(listing.map((l) => `${l.file} ${l.sha256}`).join('\n')),
    listing,
  };
  writeFileSync(join(dir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

const sha = (s) => createHash('sha256').update(s).digest('hex');

// ─── 2. What the model saw ───────────────────────────────────────────────────

/**
 * Model-visible text of one `hook_success` attachment.
 * @returns {{text: string, system: string, updatedPrompt: string|null}}
 */
export function visibleText(att) {
  const stdout = att?.stdout || '';
  if (!stdout) return { text: '', system: '', updatedPrompt: null };
  try {
    const j = JSON.parse(stdout);
    if (j && typeof j === 'object' && !Array.isArray(j)) {
      const hso = j.hookSpecificOutput || {};
      return {
        text: typeof hso.additionalContext === 'string' ? hso.additionalContext : '',
        system: typeof j.systemMessage === 'string' ? j.systemMessage : '',
        updatedPrompt: typeof hso.updatedInput?.prompt === 'string' ? hso.updatedInput.prompt : null,
      };
    }
  } catch {
    /* plain stdout */
  }
  return { text: stdout, system: '', updatedPrompt: null };
}

// ─── 3. Line classes ─────────────────────────────────────────────────────────

const RECALL_HEADER = /^\[mem\] (?:PreToolUse|PostToolUse) recall — /;
const BLANK = /^\s*$/;

/**
 * Per face: ordered [class, regex] rows. A line matching none INHERITS the class of the
 * previous non-blank line (a lesson body that wraps, the dashboard's 🔄 / 💡 rows, a
 * handoff's inner tags) and is `other` only when nothing precedes it.
 */
export const LINE_CLASSES = {
  pretool: [
    ['header', RECALL_HEADER],
    ['file_info', /^\[mem\] 📄 /],
    ['reread_warn', /^\[mem\] 🔁 /],
    ['lessons_for', /^\[mem\] Lessons for /],
    ['lesson_row', new RegExp(`^\\s{0,6}E?#${OBS_ID_DIGITS} \\[`)],
    ['edit_directive', /^\[mem\] ⚠ (?:Before this edit: |#\d+ → this edit must: )/],
    ['read_edit_nudge', /^\[mem\] ⚠ Lessons .+ were shown when you Read /],
    ['no_prior_nudge', /^\[mem\] No prior lessons for /],
  ],
  posttool_edit: [
    ['header', RECALL_HEADER],
    ['edit_drop_warn', /^\[mem\] ⚠ your edit to /],
  ],
  session_start: [
    ['dashboard', /^\[mem\] Startup dashboard:/],
    ['unsaved_nudge', /^\[mem\] Last session: \d+ unsaved/],
    ['cite_recall_nudge', /^\[mem\] Last session cite-recall/],
    ['decision_nudge', /^\[mem\] ⚠ Last session mentioned a finalized decision/],
    ['upgrade_banner', /^\[mem\] v\d+\.\d+\.\d+ upgrade notice/],
    ['warning', /^⚠️ \[claude-mem-lite\]/],
    ['steering', /^## claude-mem-lite — persistent memory/],
    ['ctx_tag', /^<\/?claude-mem-context>/],
    // `### Name (…)` → ctx:name — every section of the <claude-mem-context> block by its own
    // heading, so a section added later shows up under its name instead of under `other`.
    ['ctx:*', /^### (.+)$/],
  ],
  ups_search: [
    ['fyi', /^\[mem\] FYI — Related memories/],
    ['past_questions', /^\[mem\] FYI — Past similar questions/],
    ['deferred_ref', /^\[mem\] Deferred work (?:referenced|matches)/],
  ],
  ups_context: [
    ['handoff', /^\[mem\] Resumed context from previous session/],
    ['memory_context', /^<memory-context/],
    ['task_imperative', new RegExp('^' + TASK_IMPERATIVE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))],
  ],
  posttool: [
    ['header', RECALL_HEADER],
    ['error_recall', /^\[claude-mem-lite\] Related memories found for this error/],
    ['mem_get_hint', /^→ Use mem_get\(ids=/],
    ['unsaved_nudge', /^\[mem\] ⚠ Unsaved bugfix-shape/],
    ['cite_back', /^\[mem\] ⚠ Cite-back:/],
  ],
};
LINE_CLASSES.posttool_failure = LINE_CLASSES.posttool;

function sectionSlug(name) {
  return name
    .replace(/\(.*$/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Split one block into line classes.
 * @returns {Array<{cls: string, bytes: number, line: string}>}
 */
export function classifyLines(face, text) {
  const rows = LINE_CLASSES[face] || [];
  const lines = String(text).split('\n');
  const out = [];
  let prev = null;
  lines.forEach((line, i) => {
    const bytes = Buffer.byteLength(line) + (i < lines.length - 1 ? 1 : 0);
    if (BLANK.test(line)) {
      out.push({ cls: 'blank', bytes, line });
      return;
    }
    let cls = null;
    for (const [name, re] of rows) {
      const m = re.exec(line);
      if (!m) continue;
      cls = name === 'ctx:*' ? `ctx:${sectionSlug(m[1])}` : name;
      break;
    }
    if (!cls) cls = prev || 'other';
    out.push({ cls, bytes, line });
    prev = cls;
  });
  return out;
}

/** A block's classes must sum to the block — the accounting cannot lose or invent bytes. */
export function assertClassesSumToText(face, text, classes = classifyLines(face, text)) {
  const sum = classes.reduce((a, c) => a + c.bytes, 0);
  const want = Buffer.byteLength(String(text));
  if (sum !== want) {
    throw new Error(`line accounting: ${face} classes sum to ${sum} B but the block is ${want} B`);
  }
}

// ─── 4. Walk ─────────────────────────────────────────────────────────────────

/**
 * One session → its ordered events: prompts, assistant text, tool calls, and this plugin's
 * attachments with their classes. Main thread only (sidechain attachments belong to a
 * subagent's context).
 */
export function sessionEvents(entries) {
  const events = [];
  const toolUses = new Map();
  let turn = 0;
  let prompt = null;
  for (const [index, e] of entries.entries()) {
    if (e?.isSidechain === true) continue;
    // Compaction is where SessionStart(compact) resets the per-thread "shown once" marker
    // (lib/recall-shown.mjs) — the after-arm projection replays that reset here.
    if (e?.type === 'system' && e.subtype === 'compact_boundary') {
      events.push({ kind: 'compact', turn });
      continue;
    }
    if (e?.type === 'user') {
      const p = hookPromptOf(e);
      if (p !== null && (e.origin?.kind ?? 'human') === 'human') {
        turn++;
        prompt = p;
        events.push({ kind: 'prompt', turn, text: p });
      }
      continue;
    }
    if (e?.type === 'assistant' && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) {
        if (b?.type === 'text' && typeof b.text === 'string')
          events.push({ kind: 'text', turn, text: b.text });
        if (b?.type === 'tool_use') {
          const tu = { kind: 'tool', turn, id: b.id, name: b.name, input: b.input || {} };
          toolUses.set(b.id, tu);
          events.push(tu);
        }
      }
      continue;
    }
    if (e?.type !== 'attachment') continue;
    const att = e.attachment;
    if (!att || att.type !== 'hook_success') continue;
    const event = att.hookEvent || '?';
    const face = memFaceOf(event, att.command);
    const vis = visibleText(att);
    events.push({
      kind: 'hook',
      index,
      turn,
      prompt,
      event,
      face,
      label: face ? null : otherHookLabel(event, att.command),
      toolUseID: att.toolUseID || null,
      text: vis.text,
      system: vis.system,
      updatedPrompt: vis.updatedPrompt,
    });
  }
  return { events, toolUses };
}

function emptyFaceRow() {
  return { fires: 0, nonEmpty: 0, bytes: 0, systemBytes: 0, classes: {} };
}

/** Byte accounting over the population. */
export function accountBytes(sessionsEvents) {
  const faces = {};
  const others = {};
  const pretoolMix = { fires: 0, lessons: 0, nudgeOnly: 0, fileInfoOnly: 0, rereadOnly: 0, other: 0 };
  let agentAdded = 0;
  let agentFires = 0;
  for (const { events, toolUses } of sessionsEvents) {
    for (const ev of events) {
      if (ev.kind !== 'hook') continue;
      if (!ev.face) {
        const b = Buffer.byteLength(ev.text);
        const r = (others[ev.label] ||= { fires: 0, bytes: 0 });
        r.fires++;
        r.bytes += b;
        continue;
      }
      if (ev.face === 'pretool_agent' && ev.updatedPrompt !== null) {
        const orig = toolUses.get(ev.toolUseID)?.input?.prompt;
        agentFires++;
        if (typeof orig === 'string')
          agentAdded += Math.max(0, Buffer.byteLength(ev.updatedPrompt) - Buffer.byteLength(orig));
      }
      const row = (faces[ev.face] ||= emptyFaceRow());
      row.fires++;
      row.systemBytes += Buffer.byteLength(ev.system);
      if (!ev.text.trim()) continue;
      row.nonEmpty++;
      row.bytes += Buffer.byteLength(ev.text);
      const classes = classifyLines(ev.face, ev.text);
      assertClassesSumToText(ev.face, ev.text, classes);
      for (const c of classes) {
        const k = (row.classes[c.cls] ||= { lines: 0, bytes: 0 });
        k.lines++;
        k.bytes += c.bytes;
      }
      if (ev.face === 'pretool') {
        const set = new Set(classes.map((c) => c.cls));
        pretoolMix.fires++;
        if (set.has('lesson_row')) pretoolMix.lessons++;
        else if (set.has('read_edit_nudge')) pretoolMix.nudgeOnly++;
        else if (set.has('file_info')) pretoolMix.fileInfoOnly++;
        else if (set.has('reread_warn')) pretoolMix.rereadOnly++;
        else pretoolMix.other++;
      }
    }
  }
  return { faces, others, pretoolMix, agent: { fires: agentFires, addedBytes: agentAdded } };
}

// ─── 5. Value proxies ────────────────────────────────────────────────────────

const FILE_INFO_RE = /^\[mem\] 📄 (.+?) ~([\d.]+k?) tok/;
const PARTIAL_BASH_RE = /\b(?:sed\s+-n|head|tail|grep|rg|awk|wc|jq|cut)\b/;

/** How the call a file-info line rode on read the file. */
export function triggerKind(tool) {
  if (!tool) return 'unknown';
  if (tool.name === 'Read') {
    const i = tool.input || {};
    return i.offset != null || i.limit != null ? 'read_partial' : 'read_full';
  }
  if (tool.name === 'Bash')
    return PARTIAL_BASH_RE.test(String(tool.input?.command || '')) ? 'bash_partial' : 'bash_full';
  return `other:${tool.name}`;
}

function targetsFile(tool, fname) {
  const i = tool.input || {};
  const hay = [i.file_path, i.path, i.command, i.pattern && i.path, i.notebook_path]
    .filter(Boolean)
    .join(' ');
  return hay.includes(fname);
}

function isSliceOf(tool, fname) {
  if (!targetsFile(tool, fname)) return false;
  if (tool.name === 'Read') return tool.input?.offset != null || tool.input?.limit != null;
  if (tool.name === 'Grep') return true;
  if (tool.name === 'Bash') return PARTIAL_BASH_RE.test(String(tool.input?.command || ''));
  return false;
}

export function fileInfoValue(sessionsEvents) {
  const r = {
    lines: 0,
    trigger: {},
    byTrigger: {},
    laterSliceSameTurn: 0,
    laterFullReadSameTurn: 0,
    sizeNamed: 0,
    bigFiles: 0,
    bigLaterSlice: 0,
  };
  for (const { events, toolUses } of sessionsEvents) {
    events.forEach((ev, idx) => {
      if (ev.kind !== 'hook' || ev.face !== 'pretool') return;
      for (const line of ev.text.split('\n')) {
        const m = FILE_INFO_RE.exec(line);
        if (!m) continue;
        const [, fname, tok] = m;
        r.lines++;
        const trig = triggerKind(toolUses.get(ev.toolUseID));
        r.trigger[trig] = (r.trigger[trig] || 0) + 1;
        const big = /k$/.test(tok) && parseFloat(tok) >= 10;
        if (big) r.bigFiles++;
        let slice = false;
        let full = false;
        let named = false;
        for (let j = idx + 1; j < events.length && events[j].turn === ev.turn; j++) {
          const later = events[j];
          if (later.kind === 'tool' && later.id !== ev.toolUseID) {
            if (isSliceOf(later, fname)) slice = true;
            else if (later.name === 'Read' && targetsFile(later, fname)) full = true;
          }
          if (
            later.kind === 'text' &&
            later.text.includes(fname) &&
            new RegExp(`${tok.replace('.', '\\.')}\\s*tok`).test(later.text)
          )
            named = true;
        }
        if (slice) r.laterSliceSameTurn++;
        if (full) r.laterFullReadSameTurn++;
        if (named) r.sizeNamed++;
        if (big && slice) r.bigLaterSlice++;
        const t = (r.byTrigger[trig] ||= { lines: 0, laterSlice: 0, laterFull: 0 });
        t.lines++;
        if (slice) t.laterSlice++;
        if (full) t.laterFull++;
      }
    });
  }
  return r;
}

const RECENT_ROW_RE = new RegExp(`^\\| #(${OBS_ID_DIGITS}) \\|`);
const KEYCTX_ID_RE = new RegExp(`#(${OBS_ID_DIGITS})\\b`);
const DEFERRED_ROW_RE = /\(D#(\d+)\)\s*$/;
const D_MENTION_RE = /(?<![A-Za-z0-9])D#(\d+)\b/g;
const P_ROW_RE = /^P#(\d+) \S+ (.*)$/;
const P_MENTION_RE = /(?<![A-Za-z0-9])P#(\d+)\b/g;

const norm = (s) => String(s).replace(/…$/, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Whether a past-question row's (truncated) text is an echo of `prompt`: the row's text,
 * normalized, is a prefix of the prompt's or the other way round, over at least 12 chars.
 */
export function isEcho(rowText, prompt) {
  const a = norm(rowText);
  const b = norm(prompt);
  if (a.length < 12 || b.length < 12) return a === b && a.length > 0;
  return b.startsWith(a) || a.startsWith(b.slice(0, a.length));
}

export function sessionStartAndUpsValue(sessions, sessionsEvents) {
  const out = {
    recent: { pairs: 0, cited: 0 },
    keyContext: { pairs: 0, cited: 0 },
    deferred: { pairs: 0, named: 0 },
    activityHint: { sessions: 0, ran: 0 },
    pastQuestions: { rows: 0, named: 0, echoCurrent: 0, echoEarlierSameSession: 0 },
    deferredRef: { pairs: 0, named: 0 },
    handoff: { sessions: 0, withLastSessionOrWorkingState: 0, handoffBytes: 0, dupBytes: 0 },
  };
  sessions.forEach((s, si) => {
    const { events } = sessionsEvents[si];
    const cited = extractCitationsFromTranscript(s.path, { mainOnly: true });
    const mainText = events
      .filter((e) => e.kind === 'text')
      .map((e) => e.text)
      .join('\n');
    const dNamed = new Set([...mainText.matchAll(D_MENTION_RE)].map((m) => Number(m[1])));
    const pNamed = new Set([...mainText.matchAll(P_MENTION_RE)].map((m) => Number(m[1])));
    const recentIds = new Set();
    const keyIds = new Set();
    const deferredIds = new Set();
    const deferredRefIds = new Set();
    let sawActivityHint = false;
    let ssLastOrWorking = false;
    let ssLastOrWorkingBytes = 0;
    let handoffBytes = 0;
    const prompts = [];
    for (const ev of events) {
      if (ev.kind === 'prompt') prompts.push(ev.text);
      if (ev.kind !== 'hook' || !ev.face || !ev.text.trim()) continue;
      const classes = classifyLines(ev.face, ev.text);
      if (ev.face === 'session_start') {
        for (const c of classes) {
          let m;
          if (c.cls.startsWith('ctx:recent') && (m = RECENT_ROW_RE.exec(c.line))) recentIds.add(Number(m[1]));
          if (c.cls.startsWith('ctx:key_context') && (m = KEYCTX_ID_RE.exec(c.line)))
            keyIds.add(Number(m[1]));
          if (c.cls === 'ctx:deferred_work' && (m = DEFERRED_ROW_RE.exec(c.line)))
            deferredIds.add(Number(m[1]));
          if (c.cls === 'dashboard' && c.line.includes('activity recent')) sawActivityHint = true;
          if (c.cls === 'ctx:last_session' || c.cls === 'ctx:working_state') {
            ssLastOrWorking = true;
            ssLastOrWorkingBytes += c.bytes;
          }
        }
      }
      if (ev.face === 'ups_search') {
        const current = ev.prompt || '';
        const earlier = prompts.slice(0, -1);
        for (const c of classes) {
          if (c.cls === 'past_questions') {
            const m = P_ROW_RE.exec(c.line.trim());
            if (!m) continue;
            out.pastQuestions.rows++;
            if (pNamed.has(Number(m[1]))) out.pastQuestions.named++;
            if (isEcho(m[2], current)) out.pastQuestions.echoCurrent++;
            else if (earlier.some((p) => isEcho(m[2], p))) out.pastQuestions.echoEarlierSameSession++;
          }
          if (c.cls === 'deferred_ref') {
            const m = /^D#(\d+) /.exec(c.line.trim());
            if (m) deferredRefIds.add(Number(m[1]));
          }
        }
      }
      if (ev.face === 'ups_context') {
        for (const c of classes) if (c.cls === 'handoff') handoffBytes += c.bytes;
      }
    }
    for (const id of recentIds) {
      out.recent.pairs++;
      if (cited.has(id)) out.recent.cited++;
    }
    for (const id of keyIds) {
      out.keyContext.pairs++;
      if (cited.has(id)) out.keyContext.cited++;
    }
    for (const id of deferredIds) {
      out.deferred.pairs++;
      if (dNamed.has(id)) out.deferred.named++;
    }
    for (const id of deferredRefIds) {
      out.deferredRef.pairs++;
      if (dNamed.has(id)) out.deferredRef.named++;
    }
    if (sawActivityHint) {
      out.activityHint.sessions++;
      const ran = events.some(
        (e) =>
          e.kind === 'tool' &&
          e.name === 'Bash' &&
          /\bactivity\b/.test(String(e.input?.command || '')) &&
          /claude-mem-lite|cli\.mjs/.test(String(e.input?.command || '')),
      );
      if (ran) out.activityHint.ran++;
    }
    if (handoffBytes > 0) {
      out.handoff.sessions++;
      out.handoff.handoffBytes += handoffBytes;
      if (ssLastOrWorking) {
        out.handoff.withLastSessionOrWorkingState++;
        out.handoff.dupBytes += ssLastOrWorkingBytes;
      }
    }
  });
  return out;
}

// ─── 5b. After-arm projection ───────────────────────────────────────────────
//
// Re-renders each RECORDED block through the SHIPPED decision functions, so an after-arm reads
// the same sessions as the before-arm (doctrine rule 2) without re-running them:
//   C1/C3  planRecallBlock (lib/recall-shown.mjs), per main thread, reset at compact_boundary
//   C2     fileIntelEnabled (lib/file-intel.mjs) — the file-info line goes unless opted in
//   C4     recentTableRowCap (hook-context.mjs) — Recent rows past the cap go
//   C5     past-question rows that echo the triggering prompt or an earlier prompt of the
//          session go. APPROXIMATE: production compares full texts (isPromptEcho) and excludes
//          the session in SQL; a recorded row is cut to 80 chars, so this uses the prefix test
//          isEcho, and it cannot add the row an OR relaxation would have found instead.
//   C6     the dashboard's `💡 mem events` line goes (and the dashboard, if that empties it)
// What a projection cannot show is how the model would have BEHAVED; it prices bytes and proves
// which ids still reach it. Both self-checks below run on every --project.

/** Every switch at its pre-change value: the projection must then be the identity. */
export const RESTORE_ENV = Object.freeze({
  CLAUDE_MEM_RECALL_HEADER_ONCE: '0',
  CLAUDE_MEM_DIRECTIVE_ONCE: '0',
  CLAUDE_MEM_FILE_INTEL: '1',
  CLAUDE_MEM_STARTUP_RECENT_ROWS: '1000000',
});

const BRIDGE_LINE = /→ this edit must:/;

function projectPretool(text, state, env) {
  const keepIntel = fileIntelEnabled(env);
  const lines = classifyLines('pretool', text).filter((c) => keepIntel || c.cls !== 'file_info');
  // A block left with nothing but its header is a block production never emits.
  if (!lines.some((c) => c.cls !== 'header' && c.cls !== 'blank')) return '';
  const dir = lines.find(
    (c) => (c.cls === 'edit_directive' || c.cls === 'read_edit_nudge') && !BRIDGE_LINE.test(c.line),
  );
  const plan = planRecallBlock(
    state.shown,
    { header: lines.some((c) => c.cls === 'header'), directive: Boolean(dir) },
    env,
  );
  state.shown = plan.next;
  return lines
    .filter((c) => c.cls !== 'header' || plan.header)
    .map((c) =>
      c === dir && plan.directive === 'short' ? c.line.replace(ACK_DIRECTIVE, ACK_DIRECTIVE_SHORT) : c.line,
    )
    .join('\n');
}

function projectSessionStart(text, env, opts) {
  const cls = classifyLines('session_start', text);
  const cap = recentTableRowCap(env);
  let rows = 0;
  let out = [];
  let inRecent = false;
  for (const c of cls) {
    if (c.cls.startsWith('ctx:recent') && /^### /.test(c.line)) inRecent = true;
    else if (inRecent && !c.cls.startsWith('ctx:recent') && c.cls !== 'blank') inRecent = false;
    if (inRecent && cap === 0) continue; // the whole section goes
    if (inRecent && /^\| #/.test(c.line) && ++rows > cap) continue;
    if (opts.c6 && c.cls === 'dashboard' && c.line.startsWith('💡 mem events')) continue;
    out.push(c);
  }
  if (opts.c6) {
    // A dashboard left with only its heading is '' in production (buildDashboard), and its part
    // — joined to the next with a blank line — goes with it.
    const h = out.findIndex((c) => c.line.startsWith('[mem] Startup dashboard:'));
    if (h !== -1 && (h + 1 >= out.length || out[h + 1].cls !== 'dashboard')) {
      const startsPart = h === 0 || out[h - 1].cls === 'blank';
      out.splice(h, startsPart && out[h + 1]?.cls === 'blank' ? 2 : 1);
    }
  }
  return out.map((c) => c.line).join('\n');
}

function projectUpsSearch(text, state, prompt, opts) {
  if (!opts.c5) return text;
  const cls = classifyLines('ups_search', text);
  const earlier = state.prompts.slice(0, -1);
  const out = cls.filter((c) => {
    if (c.cls !== 'past_questions') return true;
    const m = P_ROW_RE.exec(c.line.trim());
    if (!m) return true;
    return !(isEcho(m[2], prompt || '') || earlier.some((p) => isEcho(m[2], p)));
  });
  // The section heading goes when no row of it is left.
  const final = out.filter(
    (c, i) =>
      !(c.cls === 'past_questions' && /^\[mem\] FYI — Past similar questions/.test(c.line)) ||
      out.slice(i + 1).some((d) => d.cls === 'past_questions' && P_ROW_RE.test(d.line.trim())),
  );
  if (!final.some((c) => c.cls !== 'blank')) return '';
  return final.map((c) => c.line).join('\n');
}

/**
 * One session's hook events with their text replaced by what the shipped code would inject.
 * @returns {Array} events, same order; projected hook events carry `before` (the recorded text)
 */
export function projectSessionEvents(events, env = process.env, opts = { c5: true, c6: true }) {
  const state = { shown: { header: false, directive: false }, prompts: [] };
  return events.map((ev) => {
    if (ev.kind === 'compact') state.shown = { header: false, directive: false };
    if (ev.kind === 'prompt') state.prompts.push(ev.text);
    if (ev.kind !== 'hook' || !ev.face || !ev.text.trim()) return ev;
    let text = ev.text;
    if (ev.face === 'pretool') text = projectPretool(ev.text, state, env);
    else if (ev.face === 'session_start') text = projectSessionStart(ev.text, env, opts);
    else if (ev.face === 'ups_search') text = projectUpsSearch(ev.text, state, ev.prompt, opts);
    return { ...ev, text, before: ev.text };
  });
}

/** With every switch restored and C5/C6 off, the projection must reproduce every block. */
export function assertIdentityProjection(sessionsEvents, project = projectSessionEvents) {
  let blocks = 0;
  for (const { events } of sessionsEvents) {
    for (const ev of project(events, RESTORE_ENV, { c5: false, c6: false })) {
      if (ev.kind !== 'hook' || ev.before === undefined) continue;
      blocks++;
      if (ev.text !== ev.before) {
        throw new Error(
          `projection identity: a ${ev.face} block changed with every switch restored — ` +
            `the re-render does not reproduce what was recorded (${Buffer.byteLength(ev.before)} B → ${Buffer.byteLength(ev.text)} B)`,
        );
      }
    }
  }
  return blocks;
}

const LESSON_ID_RE = new RegExp(`^\\s{0,6}(E?#${OBS_ID_DIGITS}) \\[`);
const lessonIds = (face, text) =>
  classifyLines(face, text)
    .filter((c) => c.cls === 'lesson_row')
    .map((c) => LESSON_ID_RE.exec(c.line)?.[1])
    .filter(Boolean);

/** No projected block may lose a lesson row: that is what keeps the cite pairs. */
export function assertNoLessonRowLost(projectedSessions) {
  for (const events of projectedSessions) {
    for (const ev of events) {
      if (ev.kind !== 'hook' || ev.before === undefined || ev.face !== 'pretool') continue;
      const a = lessonIds('pretool', ev.before).join(',');
      const b = lessonIds('pretool', ev.text).join(',');
      if (a !== b) throw new Error(`projection lost lesson rows: [${a}] → [${b}]`);
    }
  }
}

/** Write a copy of the corpus whose hook stdout is the projected text (for citation-live-replay). */
function writeProjected(corpus, projectedSessions, dir) {
  corpus.sessions.forEach((s, si) => {
    const byIndex = new Map();
    for (const ev of projectedSessions[si])
      if (ev.kind === 'hook' && ev.before !== undefined) byIndex.set(ev.index, ev.text);
    const lines = s.kept.map((k, i) => {
      if (!byIndex.has(i)) return k.line;
      const o = structuredClone(k.entry);
      const text = byIndex.get(i);
      let parsed = null;
      try {
        parsed = JSON.parse(o.attachment.stdout);
      } catch {
        /* plain stdout */
      }
      if (parsed && typeof parsed === 'object' && parsed.hookSpecificOutput) {
        if (text) {
          parsed.hookSpecificOutput.additionalContext = text;
          o.attachment.stdout = JSON.stringify(parsed);
        } else o.attachment.stdout = '';
      } else o.attachment.stdout = text;
      return JSON.stringify(o);
    });
    mkdirSync(join(dir, s.project), { recursive: true });
    writeFileSync(join(dir, s.project, `${s.session}.jsonl`), lines.join('\n') + '\n');
    for (const sub of findSubagentTranscripts(s.path)) {
      const subDir = join(dir, s.project, s.session, 'subagents');
      mkdirSync(subDir, { recursive: true });
      writeFileSync(join(subDir, basename(sub)), readFileSync(sub));
    }
  });
}

// ─── 6. Report ───────────────────────────────────────────────────────────────

const kb = (b) => (b / 1024).toFixed(2);

function printReport(meta, acct, value) {
  const n = meta.sessions;
  console.log(`injection budget — ${n} sessions (${meta.files} transcripts walked) under ${meta.root}`);
  console.log(`  window: start in [${meta.since ?? '-∞'}, ${meta.until ?? '+∞'}), records cut at until\n`);
  const memTotal = Object.values(acct.faces).reduce((a, r) => a + r.bytes, 0);
  const othTotal = Object.values(acct.others).reduce((a, r) => a + r.bytes, 0);
  console.log(`ALL hooks ${kb(memTotal + othTotal)} KB total = ${kb((memTotal + othTotal) / n)} KB/session`);
  console.log(
    `  claude-mem-lite ${kb(memTotal)} KB = ${kb(memTotal / n)} KB/session (${((100 * memTotal) / (memTotal + othTotal || 1)).toFixed(1)}%)`,
  );
  console.log(`  others          ${kb(othTotal)} KB = ${kb(othTotal / n)} KB/session\n`);
  console.log(
    `${'face'.padEnd(18)} ${'fires'.padStart(6)} ${'nonEmpty'.padStart(8)} ${'KB'.padStart(8)} ${'KB/sess'.padStart(8)} ${'B/fire'.padStart(7)}`,
  );
  for (const [face, r] of Object.entries(acct.faces).sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(
      `${face.padEnd(18)} ${String(r.fires).padStart(6)} ${String(r.nonEmpty).padStart(8)} ${kb(r.bytes).padStart(8)} ${kb(r.bytes / n).padStart(8)} ${String(Math.round(r.bytes / (r.nonEmpty || 1))).padStart(7)}`,
    );
    for (const [cls, c] of Object.entries(r.classes).sort((a, b) => b[1].bytes - a[1].bytes)) {
      console.log(
        `    ${cls.padEnd(22)} lines ${String(c.lines).padStart(5)}  ${kb(c.bytes).padStart(8)} KB  ${kb(c.bytes / n).padStart(6)} KB/sess`,
      );
    }
    if (r.systemBytes) console.log(`    (systemMessage, user-facing: ${kb(r.systemBytes)} KB)`);
  }
  const m = acct.pretoolMix;
  console.log(
    `\npretool blocks: ${m.fires} — with lesson rows ${m.lessons}, Read→Edit nudge only ${m.nudgeOnly}, file-info only ${m.fileInfoOnly}, re-read warning only ${m.rereadOnly}, other ${m.other}`,
  );
  console.log(
    `pretool_agent: ${acct.agent.fires} subagent prompts rewritten, +${kb(acct.agent.addedBytes)} KB into SUBAGENT context (not counted above)`,
  );
  console.log('\nothers by hook:');
  for (const [k, r] of Object.entries(acct.others)
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 12)) {
    if (r.bytes)
      console.log(
        `  ${k.padEnd(60)} ${String(r.fires).padStart(5)} ${kb(r.bytes).padStart(8)} KB ${kb(r.bytes / n).padStart(6)} KB/sess`,
      );
  }
  if (!value) return;
  const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}% (${a}/${b})` : 'n/a (0)');
  const f = value.fileInfo;
  console.log('\nVALUE PROXIES');
  console.log(`file_info lines ${f.lines}; trigger: ${JSON.stringify(f.trigger)}`);
  console.log(
    `  later same-turn slice/grep of the same file ${pct(f.laterSliceSameTurn, f.lines)}; later full Read ${pct(f.laterFullReadSameTurn, f.lines)}; size named in text ${pct(f.sizeNamed, f.lines)}`,
  );
  console.log(`  files >=10k tok: ${f.bigFiles}, of which later sliced ${pct(f.bigLaterSlice, f.bigFiles)}`);
  for (const [t, x] of Object.entries(f.byTrigger).sort((a, b) => b[1].lines - a[1].lines)) {
    console.log(
      `  trigger ${t.padEnd(13)} ${String(x.lines).padStart(5)} lines · later slice ${pct(x.laterSlice, x.lines)} · later full Read ${pct(x.laterFull, x.lines)}`,
    );
  }
  const v = value.ss;
  console.log(
    `SessionStart Recent ids cited ${pct(v.recent.cited, v.recent.pairs)} · Key Context ids cited ${pct(v.keyContext.cited, v.keyContext.pairs)} · Deferred D# named ${pct(v.deferred.named, v.deferred.pairs)}`,
  );
  console.log(
    `  dashboard 'activity recent' hint: ran in ${pct(v.activityHint.ran, v.activityHint.sessions)} sessions`,
  );
  console.log(
    `UPS past questions: rows ${v.pastQuestions.rows}; P# named ${pct(v.pastQuestions.named, v.pastQuestions.rows)}; echo of the triggering prompt ${pct(v.pastQuestions.echoCurrent, v.pastQuestions.rows)}; echo of an earlier prompt this session ${pct(v.pastQuestions.echoEarlierSameSession, v.pastQuestions.rows)}`,
  );
  console.log(`UPS deferred-ref D# named ${pct(v.deferredRef.named, v.deferredRef.pairs)}`);
  console.log(
    `handoff: ${v.handoff.sessions} sessions, ${kb(v.handoff.handoffBytes)} KB; SessionStart also carried Last Session/Working State in ${pct(v.handoff.withLastSessionOrWorkingState, v.handoff.sessions)} (${kb(v.handoff.dupBytes)} KB of those sections)`,
  );
}

function main() {
  assertHookTableCoversShippedWiring();
  const root = transcriptRoot();
  const since = parseWhen('--since');
  const until = parseWhen('--until');
  const corpus = loadCorpus(root, since, until);
  if (!corpus.sessions.length) {
    console.error(
      `no session in the population under ${root} — check --since/--until and CLAUDE_MEM_TRANSCRIPT_ROOT`,
    );
    process.exit(1);
  }
  const meta = {
    root,
    files: corpus.files,
    sessions: corpus.sessions.length,
    since: Number.isFinite(since) ? new Date(since).toISOString() : null,
    until: Number.isFinite(until) ? new Date(until).toISOString() : null,
  };
  const dir = argOf('--freeze');
  if (dir) {
    if (existsSync(dir) && readdirSync(dir).length) {
      console.error(`--freeze: ${dir} is not empty — a frozen corpus is written once`);
      process.exit(1);
    }
    mkdirSync(dir, { recursive: true });
    const man = freeze(corpus, dir, { root, since, until });
    // stderr, so `--freeze … --json` still prints one parseable document on stdout.
    console.error(
      `froze ${man.sessions} sessions / ${man.files} files to ${dir} (listing sha256 ${man.listingSha256.slice(0, 16)}…)`,
    );
  }
  const sessionsEvents = corpus.sessions.map((s) => sessionEvents(s.entries));
  const acct = accountBytes(sessionsEvents);
  const value = has('--value')
    ? {
        fileInfo: fileInfoValue(sessionsEvents),
        ss: sessionStartAndUpsValue(corpus.sessions, sessionsEvents),
      }
    : null;
  let after = null;
  const projectedDir = argOf('--write-projected');
  if (has('--project') || projectedDir) {
    const identityBlocks = assertIdentityProjection(sessionsEvents);
    // `{}`: the shipped DEFAULTS, whatever this shell exports.
    const projected = sessionsEvents.map(({ events, toolUses }) => ({
      events: projectSessionEvents(events, {}),
      toolUses,
    }));
    assertNoLessonRowLost(projected.map((p) => p.events));
    after = { ...accountBytes(projected), identityBlocks };
    if (projectedDir) {
      if (existsSync(projectedDir) && readdirSync(projectedDir).length) {
        console.error(`--write-projected: ${projectedDir} is not empty`);
        process.exit(1);
      }
      mkdirSync(projectedDir, { recursive: true });
      writeProjected(
        corpus,
        projected.map((p) => p.events),
        projectedDir,
      );
      console.error(`wrote the projected corpus to ${projectedDir}`);
    }
  }
  if (has('--json')) {
    console.log(JSON.stringify({ meta, ...acct, value, after }, null, 2));
    return;
  }
  printReport(meta, acct, value);
  if (after) printAfter(meta, acct, after);
}

function printAfter(meta, before, after) {
  const n = meta.sessions;
  const sum = (a) => Object.values(a.faces).reduce((x, r) => x + r.bytes, 0);
  console.log(
    `\nAFTER (shipped defaults, recorded blocks re-rendered; identity self-check passed on ${after.identityBlocks} blocks, no lesson row lost)`,
  );
  console.log(`claude-mem-lite ${kb(sum(before) / n)} → ${kb(sum(after) / n)} KB/session`);
  for (const [face, r] of Object.entries(before.faces).sort((a, b) => b[1].bytes - a[1].bytes)) {
    const a = after.faces[face] || { bytes: 0, classes: {} };
    if (r.bytes === a.bytes) continue;
    console.log(
      `  ${face.padEnd(16)} ${kb(r.bytes / n).padStart(6)} → ${kb(a.bytes / n).padStart(6)} KB/session`,
    );
    for (const [cls, c] of Object.entries(r.classes).sort((x, y) => y[1].bytes - x[1].bytes)) {
      const ac = a.classes[cls] || { lines: 0, bytes: 0 };
      if (ac.bytes === c.bytes) continue;
      console.log(
        `      ${cls.padEnd(20)} ${kb(c.bytes / n).padStart(6)} → ${kb(ac.bytes / n).padStart(6)}  (lines ${c.lines} → ${ac.lines})`,
      );
    }
  }
  const m = after.pretoolMix;
  console.log(`  pretool blocks ${before.pretoolMix.fires} → ${m.fires}`);
}

// Run only when invoked as a script; importing stays side-effect-free for the tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
