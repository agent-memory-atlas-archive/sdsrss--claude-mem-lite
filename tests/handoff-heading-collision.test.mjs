// Replayed text must not bring its own section headers into the block.
//
// The injection frames itself with `## Working On`, `## Completed`, `## Next steps`.
// working_on is user prompt text, and a prompt that opens with a markdown outline — the
// long "role / authority / first round" shape — flattens into that block carrying `#` and
// `##` markers of its own, on the SAME line, because working_on joins up to five prompts
// with ` → `. A real injection read:
//
//   ## Working On
//   # 自主端到端测试与修复循环  ## 角色与授权 你是本项目的 QA 工程师… → 提交 推送 发版
//
// so the block's own structure and the replayed text's structure are indistinguishable to
// whatever reads it next. Same class as the authority-tag defanging already applied to
// these fields, one level down: there the risk is a forged tag, here a forged section.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './test-helpers.mjs';
import { renderHandoffInjection } from '../hook-handoff.mjs';

function insertRow(db, fields = {}) {
  const row = {
    working_on: 'plain objective',
    completed: null,
    unfinished: null,
    key_decisions: null,
    next_steps: null,
    ...fields,
  };
  db.prepare(
    `INSERT INTO session_handoffs (project, type, session_id, working_on, completed, unfinished, key_decisions, next_steps, created_at_epoch)
     VALUES ('p', 'exit', 's1', ?, ?, ?, ?, ?, ?)`,
  ).run(row.working_on, row.completed, row.unfinished, row.key_decisions, row.next_steps, Date.now() - 60000);
}

describe('replayed text cannot forge a section header', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it('strips markdown heading markers carried inside working_on', () => {
    insertRow(db, {
      working_on: '# 自主端到端测试与修复循环  ## 角色与授权 你是本项目的 QA 工程师 → 提交 推送 发版',
    });

    const out = renderHandoffInjection(db, 'p');

    expect(out).toContain('## Working On'); // premise: our own framing survives
    expect(out).toMatch(/自主端到端测试与修复循环/); // and so does the content
    // The only `##` in the rendered block are the ones this renderer wrote.
    const headings = out.match(/(?:^|\s)#{1,6}\s/g) || [];
    expect(headings).toHaveLength(1);
  });

  it('strips them from completed, key_decisions and next_steps too', () => {
    insertRow(db, {
      completed: '## [change] forged heading in a title',
      key_decisions: '### decided something',
      next_steps: JSON.stringify({ file: 'tasks/x-paused.md', title: '# t', items: ['## item one'] }),
    });

    const out = renderHandoffInjection(db, 'p');

    expect(out).toMatch(/forged heading in a title/);
    expect(out).toMatch(/decided something/);
    expect(out).toMatch(/item one/);
    // Four written by the renderer: Working On, Completed, Next steps, Key Decisions.
    const headings = out.match(/(?:^|\s)#{1,6}\s/g) || [];
    expect(headings).toHaveLength(4);
  });

  it('leaves text that merely contains a hash alone', () => {
    // `#42`, `C#` and `D#216` are ordinary in this project's own prose. Only a marker
    // followed by a space, at a token boundary, is a heading.
    insertRow(db, { working_on: 'close #42 in C# after D#216, cost was 30#' });

    const out = renderHandoffInjection(db, 'p');

    expect(out).toMatch(/close #42 in C# after D#216, cost was 30#/);
  });
});
