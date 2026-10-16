# 注入量优化：改动和改后读数（2026-10-16，分支 `feat/injection-budget`）

基线和测量口径见 `docs/audits/20261016-injection-budget-baseline.md`。两份读数用的是同一份冻结语料
`benchmark/results/injection-corpus-20261016/`（52 个会话，列表 sha256 `b3a01b6687180025…`）。

## 改了什么

| # | 改动 | 提交 | 恢复旧行为的开关 |
|---|---|---|---|
| C1 | PreToolUse 抬头只在每个线程的第一个块出现；压缩（`/compact`）后再出现一次 | `c28c32f4` | `CLAUDE_MEM_RECALL_HEADER_ONCE=0` |
| C2 | 文件信息行（`[mem] 📄 …`）默认关闭 | `0c840368` | `CLAUDE_MEM_FILE_INTEL=1` |
| C3 | 默认档位的引用指令每个线程给一次全文，之后给保留标号规则的短句 | `c28c32f4` | `CLAUDE_MEM_DIRECTIVE_ONCE=0` |
| C4 | SessionStart 的 `### Recent` 表只给最新 5 行 | `d84e0efe` | `CLAUDE_MEM_STARTUP_RECENT_ROWS=<n>`（0 隐藏） |
| C5 | "相似问题"不再返回本会话的提示，也不返回和当前提示几乎相同的提示 | `68c70950`、`1780253d` | 无（修的是自己搜到自己） |
| C6 | 启动面板去掉 `💡 mem events …` 这一行 | `25b14389` | 无 |

线程状态放在新文件 `lib/recall-shown.mjs`：每个线程一个标记文件 `recall-shown-<线程>.json`，键和 cooldown
一样（子代理线程单独计）；SessionStart 收到 `source: compact` 时清掉主线程的标记，运行目录 GC 按 24 小时回收。
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

全部 hook 合计 25.02 → 19.11 KB/会话。用 `--write-projected` 写出的重放语料直接量，也是 12.66 KB/会话。

**引用率**：在冻结语料和重放语料上背靠背跑 `citation-live-replay.mjs`，各面的 (会话, id) 对和引用次数完全一样：

| 面 | 改前 | 改后 |
|---|---|---|
| pretool | 3/332（0.9%） | 3/332（0.9%） |
| error_recall | 1/366（0.3%） | 1/366（0.3%） |
| fyi | 1/93（1.1%） | 1/93（1.1%） |
| ups | 1/14（7.1%） | 1/14（7.1%） |

这只说明**送到模型面前的教训 id 一个没少**。模型拿到更短的上下文后引用得多还是少，录下来的语料测不出来；
而且 52 个会话里一共只有 6 次引用，就算发版后再测，也要很多会话才分得出差别。

## 离 8 KB 目标还差 4.66 KB

剩下的大头都是带价值的内容：教训行 2.66、会话交接 2.09、错误召回 1.65、引用到的 deferred 全文 1.01、
SessionStart 的 Last Session / Deferred 1.45（KB/会话）。按"两者冲突时以引用率为准"，这次停在不删教训、
不删引用指令的范围内。可以再选的删减和代价：

- 同一会话内重复的教训只给 id：约 0.6 KB/会话；编辑时教训正文只在前文里。
- 错误召回去掉 `→ Use mem_get` 提示或少给几行：0.1–1.0 KB/会话；这个面被引用 1/366，但少给行是排序改动。
- 截短 handoff 的 `<session-summary>`：0.5–1.0 KB/会话；会话连续性是插件的核心价值。
- 整个去掉 Recent 表：比 C4 再省约 0.57 KB/会话。

## 发版后怎么读

一个会话跑的是不是新代码，从它收到的文字就能分：第二个及以后的 PreToolUse 块没有抬头，或者出现短指令
`tag rule as before`。按收到的文字分组，不要按日期切（本机插件更新会滞后于 tag，`rulers.md` 里 D#104 的教训）。
要看的：PreToolUse 块后模型提前结束回合的情况（抬头当初就是为这个加的，#7758），以及 pretool 引用率。

## 发版时用的 CHANGELOG 草稿（英文，发版提交里再定稿）

- **Change: the PreToolUse framing line and the full pre-edit directive are shown once per thread.** Later recall
  blocks of the same session (or subagent) open with their own `[mem]` line and carry a short directive that keeps
  the `(#NN)` tag rule; both come back after `/compact`. `CLAUDE_MEM_RECALL_HEADER_ONCE=0` /
  `CLAUDE_MEM_DIRECTIVE_ONCE=0` restore them on every block.
- **Change: the file-intel line is opt-in** (`CLAUDE_MEM_FILE_INTEL=1`). It reaches the model next to the read's
  result, so it could not shape that read.
- **Change: the SessionStart Recent table shows the newest 5 rows** (`CLAUDE_MEM_STARTUP_RECENT_ROWS`, 0 hides it).
- **Change: the startup dashboard drops the `mem events` count.**
- **Fix: "Past similar questions" no longer returns the prompt you just typed** or another prompt of the same session.
