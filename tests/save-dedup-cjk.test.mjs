// E2E 2026-10-16 (MCP 5, data S4): the save-time near-duplicate window tokenized on whitespace, so
// a CJK sentence was one or two tokens and any edit — one trailing 。 — gave Jaccard 0: a CJK save
// was deduped only when it was identical. In the window, each CJK run now also contributes its
// character bigrams. Measured on a copy of the live DB (2026-10-16T19:42Z, 416 live rows): 148
// same-project pairs within 5 minutes, 14 of them CJK; the bigram reading marks 0 further pairs as
// duplicates, so the window gains no false merges there.

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.mjs';
import { saveObservation } from '../lib/save-observation.mjs';
import { jaccardSimilarity, jaccardSimilarityCjk } from '../hash-utils.mjs';

const PROJECT = 'x--dedup-cjk';
const BODY = '登录页面在会话过期后丢失刷新令牌，原因是中间件缓存了旧的令牌，修复方法是过期后重新读取';
let db;
beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch)
              VALUES ('cc-cjk','mem-cjk', ?, datetime('now'), ?)`,
  ).run(PROJECT, Date.now());
});
const save = (o) => saveObservation(db, { type: 'bugfix', importance: 2, project: PROJECT, ...o });

describe('save-time dedup on CJK text', () => {
  it('a one-character edit with another title is a duplicate', () => {
    const first = save({ content: BODY, title: '刷新令牌丢失' });
    expect(first.kind).toBe('saved');
    const second = save({ content: `${BODY}。`, title: '第三个标题' });
    expect(second.kind).toBe('duplicate');
    expect(second.existingId).toBe(first.id);
  });
  it('a different CJK memory is still saved', () => {
    save({ content: BODY, title: '刷新令牌丢失' });
    const other = save({
      content: '支付回调在重试时重复扣款，原因是幂等键没有写入缓存',
      title: '支付重复扣款',
    });
    expect(other.kind).toBe('saved');
  });
  // Pre-tag review 2026-10-16: each CJK run adds all its bigrams while the Latin identifier glued
  // into the sentence is one token, so in a short sentence the identifier — the part that tells
  // the two facts apart — barely moved the score: 修复了redis连接池泄漏 then 修复了mysql连接池泄漏
  // read 0.75 and the second was dropped ("Skipped: similar", exit 0), where v6.27.0 stored both.
  // The full-width forms an IME types in full-width mode are the same identifiers (round-2 review:
  // node２２ / node２０ read 0.778 and were deduped).
  it.each([
    ['修复了redis连接池泄漏', '修复了mysql连接池泄漏'],
    ['升级到node22之后构建失败', '升级到node20之后构建失败'],
    [
      '升级到node22之后构建失败，原因是原生模块没有重新编译',
      '升级到node20之后构建失败，原因是原生模块没有重新编译',
    ],
    ['升级到node２２之后构建失败', '升级到node２０之后构建失败'],
    ['修复了ｒｅｄｉｓ连接池泄漏', '修复了ｍｙｓｑｌ连接池泄漏'],
  ])('a CJK save naming another identifier or number is saved: %s / %s', (a, b) => {
    expect(save({ content: a }).kind).toBe('saved');
    expect(save({ content: b }).kind).toBe('saved');
  });
  it('the same identifiers with one CJK character changed are still a duplicate', () => {
    const withId = BODY.replace('中间件', 'redis中间件');
    const first = save({ content: withId });
    expect(first.kind).toBe('saved');
    expect(save({ content: `${withId}。` }).kind).toBe('duplicate');
  });
  it('English text scores as before', () => {
    const a = 'Redis pool exhaustion: raised maxclients to 2000';
    const b = 'Redis pool exhaustion: raised maxclients to 4000';
    expect(jaccardSimilarityCjk(a, b)).toBe(jaccardSimilarity(a, b));
  });
});
