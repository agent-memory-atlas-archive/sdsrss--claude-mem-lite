# 注入量优化：改动和改后读数（2026-10-16，分支 `feat/injection-budget`）

基线和测量口径见 `docs/audits/20261016-injection-budget-baseline.md`。两份读数用的是同一份冻结语料
`benchmark/results/injection-corpus-20261016/`（52 个会话，列表 sha256 `b3a01b6687180025…`）。

## 改了什么

| # | 改动 | 提交 | 恢复旧行为的开关 |
|---|---|---|---|
| C1 | PreToolUse 抬头只在每个线程的第一个块出现；压缩（`/compact`）后再出现一次 | `c28c32f4` | `CLAUDE_MEM_RECALL_HEADER_ONCE=0` |
| C2 | 文件信息行（`[mem] 📄 …`）默认关闭 | `0c840368` | `CLAUDE_MEM_FILE_INTEL=1` |
| C3 | 默认档位的引用指令每个线程给一次全文，之后给保留标号规则的短句 | `c28c32f4` | `CLAUDE_MEM_DIRECTIVE_ONCE=0` |
| C4 | SessionStart 的 `### Recent` 表只给 5 行：本项目自己的行优先，不够再用别的项目补 | `d84e0efe`，评审修复见下 | `CLAUDE_MEM_STARTUP_RECENT_ROWS=<n>`（0 隐藏） |
| C5 | "相似问题"不再返回本会话的提示（含刚输入的这条），也不返回别的会话里和当前提示几乎相同的提示 | `68c70950`、`1780253d`，评审修复见下 | 后一半：`CLAUDE_MEM_UPS_PROMPT_ECHO=0`；前一半是 bug 修复，没有开关 |
| C6 | 启动面板去掉 `💡 mem events …` 这一行 | `25b14389`，评审修复见下 | `CLAUDE_MEM_DASHBOARD_EVENTS=1` |

线程状态放在新文件 `lib/recall-shown.mjs`：每个线程一个标记文件 `recall-shown-<线程>.json`，键和 cooldown
一样（子代理线程单独计）；SessionStart 除了 `resume` 都清掉主线程的标记（压缩、`/clear`、新启动都是新上下文；初版只在 `compact` 时清，评审后改），运行目录 GC 按 24 小时回收。
教训行一行都没动，实验档位（`verdict` / `bind` / `bridge`）的指令文字也没动。`post-tool-recall.js` 的抬头只在
`bind` 档位出现，按"实验档位文字不变"的约束没有改（和计划不同的一处）。

## 改后读数（同一冻结语料）

`CLAUDE_MEM_TRANSCRIPT_ROOT=benchmark/results/injection-corpus-20261016 node benchmark/injection-budget.mjs --project`
把记录下来的每个块，用发布代码里的决策函数重新渲染一遍（默认开关）。两项自检都通过：所有开关恢复原样时
1,923 个块逐字节不变；没有一个块丢教训行。

| 面 / 行类 | 改前 KB/会话 | 改后 KB/会话 |
|---|---|---|
| **本插件合计** | **18.57** | **12.66** |
| PreToolUse | 9.96 | 4.60 |
| 　抬头 | 2.78（1,546 行） | 0.09（52 行） |
| 　Read→Edit 提醒 | 2.03 | 1.14 |
| 　文件信息行 | 1.57（1,102 行） | 0 |
| 　编辑前指令 | 0.38 | 0.18 |
| 　（块数） | 1,546 | 1,120 |
| SessionStart | 3.09 | 2.57 |
| 　Recent 表 | 1.02 | 0.57 |
| 　启动面板 | 0.20 | 0.13 |
| UserPromptSubmit `user-prompt-search.js` | 1.53 | 1.49 |
| 　相似问题 | 0.20 | 0.16 |
| 其余各面 | 不变 | 不变 |

全部 hook 合计 25.24 → 19.33 KB/会话（含另一个插件 0.22 KB/会话的 Stop 阻断反馈）。用 `--write-projected` 写出的重放语料直接量，也是 12.66 KB/会话。

**引用率**：在冻结语料和重放语料上背靠背跑 `citation-live-replay.mjs`，各面的 (会话, id) 对和引用次数完全一样：

| 面 | 改前 | 改后 |
|---|---|---|
| pretool | 3/332（0.9%） | 3/332（0.9%） |
| error_recall | 1/366（0.3%） | 1/366（0.3%） |
| fyi | 1/93（1.1%） | 1/93（1.1%） |
| ups | 1/14（7.1%） | 1/14（7.1%） |

这只说明**送到模型面前的教训 id 一个没少**。模型拿到更短的上下文后引用得多还是少，录下来的语料测不出来；
而且 52 个会话里被引用的教训一共只有 4 个（上表按面相加是 6：会话 `2b427c71` 里对 `#210` 的一次引用，
pretool、error_recall、fyi 三个面都注入过它，各算一次；发版前评审指出），就算发版后再测，也要很多会话才分得出差别。

## 离 8 KB 目标还差 4.66 KB

剩下的大头都是带价值的内容：教训行 2.66、会话交接 2.09、错误召回 1.65、引用到的 deferred 全文 1.01、
SessionStart 的 Last Session / Deferred 1.45（KB/会话）。按"两者冲突时以引用率为准"，这次停在不删教训、
不删引用指令的范围内。可以再选的删减和代价：

- 同一会话内重复的教训只给 id：约 0.6 KB/会话；编辑时教训正文只在前文里。
- 错误召回去掉 `→ Use mem_get` 提示或少给几行：0.1–1.0 KB/会话；这个面被引用 1/366，但少给行是排序改动。
- 截短 handoff 的 `<session-summary>`：0.5–1.0 KB/会话；会话连续性是插件的核心价值。
- 整个去掉 Recent 表：比 C4 再省约 0.57 KB/会话。

## 发版前评审（两路，评审的是 `1ca93d69`）

报告原文：`docs/audits/20261016-injection-budget-pretag-defects.md`（缺陷）、
`docs/audits/20261016-injection-budget-pretag-claims.md`（说法）。两路都没有 P1。

缺陷评审用真实的 `pre-tool-recall.js` 回放了 3 个录下来的会话（1,668 次调用），尺子的重放和真实钩子在
271 个块上 0 处不同；开关全部恢复时 14 个钩子步骤和 main 完全一致；并发调用只会多出抬头、不会丢；
`verdict` / `bind` / `bridge` 档位文字不变；热路径 p50 多 0.4 ms 以内。

修了的：

- **缺陷 P2-1**：项目自己的行不足 3 条时，Recent 表先用别的项目补位、再按时间截到 5 行，会把本项目自己的行全部
  截掉（冻结语料 5/60 张表，共 10 行）。现在先保本项目的行，再用别的项目补（`lib/recent-table.mjs`
  `capRecentRows`，钩子和尺子共用）。修后这 5 张表本项目的 10 行全部保留。尺子当初没看出来，因为它重放的是
  同一个错误截法。
- **缺陷 P2-2**：C6 和 C5 后一半补了恢复开关（见上表）。
- **缺陷 P3-2**：尺子不再导入 `hook-context.mjs`，导入时不再创建运行目录。
- **缺陷 P3-3**："不丢 id"自检扩到所有面。
- **缺陷 P3-7**：SessionStart 除了 `resume` 都清主线程标记（`startup` 一定是新上下文）。
- **说法 P2-1 ～ P2-4 和 P3**：`activity` 实际 0/52（不是 4/52）、`mem events` 行 60/60（不是 56/60）、抬头有
  220 种写法（不是"都是同样的 95 字节"）、文件信息行附在部分读取上的比例 89.9%（不是 92.3%）等，尺子、代码
  注释、README 和两份审计文档都已改正（`3715e464`）。这几条也出现在更早的提交说明里，没有改写历史。

没修、照原样接受的（P3）：

- 标记只记"给过"，不记"给的是哪种文字"：同一会话中途换 `CLAUDE_MEM_SALIENCE` 档位再恢复，默认档位第一次
  给的可能是短句。
- 子代理线程的标记只靠 24 小时 GC 清，它自己压缩时不清（语料里 160 个子代理转录、本机 204 个，都没有压缩过）。
- 线程键截在 64 字符，同名长 agent 名可能共用标记（和 cooldown 同一个已有问题，D15）。
- `cjkPrecisionOk` 仍在"要不要放宽到 OR"之后才过滤，是改动前就有的同类问题，记为延后项 D#345。

两路都没能验证的：去掉后续抬头会不会让模型提前结束回合（抬头当初就是为这个加的）。只有发版后的会话能回答。

## 发版提交的评审（评审的是候选 `f12e673a`）

报告原文：`docs/audits/20261016-injection-budget-pretag-release.md`。0 个 P1、1 个 P2、6 个 P3，全部改了，
都是文字：

- **P2-1**："6 次引用"其实是 4 个被引用的教训。6 是各面相加：会话 `2b427c71` 里对 `#210` 的一次引用，在注入过它的
  pretool、error_recall、fyi 三个面上各算一次。用 `citation-live-replay.mjs --dump` 复核：面命中 6，不同的
  (会话, id) 对 4。CHANGELOG、本文、基线文档和 `rulers.md` 都已改正。
- **P3**：
  - 每会话的 KB 只算主会话，不含子代理转录（评审的读数：160 个子代理转录里还有 642.50 KB 本插件文字，合 12.36 KB/会话，本文没有复核）；CHANGELOG 已写明。
  - "2.41 → 1.32"是取整后相加，不取整是 2.40 → 1.31。
  - CHANGELOG 补了几处：Recent 表恢复旧行为的取值（大于选出行数的任意值，如 `1000`）；短指令只在默认档位；
    `claude-mem-lite context` 同样受 5 行上限。
  - `lib/recall-shown.mjs` 里清标记的注释还写着只在压缩时清，已改。

评审用真实钩子在沙箱里确认了：线程第一个块有抬头和全文指令，第二个都没有；压缩后两者都回来；每个开关都能恢复旧文字。
它没有查的：工具调用被拒绝时，钩子附加的文字还会不会送达（标记在钩子运行时就记下"给过"）。

## 发版后怎么读

一个会话跑的是不是新代码，从它收到的文字就能分：第二个及以后的 PreToolUse 块没有抬头，或者出现短指令
`tag rule as before`。按收到的文字分组，不要按日期切（本机插件更新会滞后于 tag，`rulers.md` 里 D#104 的教训）。
要看的：PreToolUse 块后模型提前结束回合的情况（抬头当初就是为这个加的，#7758），以及 pretool 引用率。

## 发版时用的 CHANGELOG 草稿（英文，发版提交里再定稿）

- **Change: the PreToolUse framing line and the full pre-edit directive are shown once per thread.** Later recall
  blocks of the same session (or subagent) open with their own `[mem]` line; those that carry a directive (an Edit
  with lessons, the Read→Edit reminder) carry a short one that keeps the `(#NN)` tag rule. Both come back after
  `/compact`. `CLAUDE_MEM_RECALL_HEADER_ONCE=0` /
  `CLAUDE_MEM_DIRECTIVE_ONCE=0` restore them on every block.
- **Change: the file-intel line is opt-in** (`CLAUDE_MEM_FILE_INTEL=1`). It rode the first read of a large file
  (a Read, or a Bash `cat` / `sed -n` / `head`) and reached the model next to that read's result, so it could not
  shape that read.
- **Change: the SessionStart Recent table shows 5 rows** — the project's own first, then other projects' rows when the
  project has few (`CLAUDE_MEM_STARTUP_RECENT_ROWS`, 0 hides it).
- **Change: the startup dashboard drops the `mem events` count** (`CLAUDE_MEM_DASHBOARD_EVENTS=1` brings it back).
- **Fix: "Past similar questions" no longer returns the prompt you just typed** or another prompt of the same session.
- **Change: it also skips a question from an earlier session that is the same as the one just typed**
  (`CLAUDE_MEM_UPS_PROMPT_ECHO=0` keeps those).
