# 注入量基线：本插件每会话往模型上下文里放了什么（2026-10-16，v6.26.1 之后）

尺子：`benchmark/injection-budget.mjs`（`a02f0536`）。引用率：`benchmark/citation-live-replay.mjs`，
同一份冻结语料。

## 语料

- 冻结目录：`benchmark/results/injection-corpus-20261016/`（gitignored，含完整转录，不提交）。
  `MANIFEST.json` 列出 212 个文件的 sha256，列表 sha256 `b3a01b6687180025…`。
- 总体：`~/.claude/projects/<项目>/<会话>.jsonl`（会话级，不递归），首个时间戳在
  [2026-09-30T00:00Z, 2026-10-16T00:00Z)，entrypoint 只有 `cli`，至少一条人类提示
  （`hookPromptOf` 非空、origin 为 human）；每个会话里时间戳 ≥ 2026-10-16T00:00Z 的记录丢掉。
  每个会话的 `subagents/` 按同一截止时间一起冻结。
- 结果：52 个会话，4 个项目。冻结于 2026-10-16T00:58:58Z，用的是 `92fdfad6` 上尚未提交的尺子
  （提交为 `a02f0536` 之前只加了按触发方式拆分的输出和 id 口径的导入，冻结和计数逻辑没动；
  提交后的版本在冻结根上重跑，计数与冻结时的输出逐行相同，只多了按触发方式拆分的几行）。
- 以后的读数都用 `CLAUDE_MEM_TRANSCRIPT_ROOT=benchmark/results/injection-corpus-20261016`，
  这样前后两臂读的是同一批会话。Claude Code 30 天后会删转录，冻结目录是唯一能重算的副本。

## 复核 claudemd 仓库 2026-10-15 的数字

原测量在 2026-10-15T21:35:24Z 左右（claudemd 会话 `eea2ca87` 第一次跑 `hook_scan.py` 的时间）。
按这个截止时间重跑：

| 来源 | 会话数 | 全部 hook KB/会话 | 本插件 KB/会话 |
|---|---|---|---|
| 原报告 | 49 | 25.6 | 18.6 |
| `hook_scan.py` 副本（排除 `eea2ca87`，记录按截止时间裁掉） | 48 | 25.6 | 18.56 |
| `injection-budget.mjs`（不排除 `eea2ca87`） | 49 | 25.10 | 18.31 |

差异来源：会话数口径（是否排除测量会话本身、人类提示的判定），以及 `hook_scan.py` 把
`systemMessage`（给用户看的）和 `reason` 也算进去了，非 JSON 的 `hook_error` 还算了它的 stderr。各面拆分和原报告一致：抬头 2.77（原 2.76）、教训行 2.58
（原 2.58）、文件信息行 1.54（原 1.54）、Read→Edit 提醒 + 编辑前指令 2.35（原"其他行" 2.36）。

**前提更正。** 原报告说 1,430 次 PreToolUse 注入里有 718 次（50%）"一条教训都没有，只有抬头和文件信息行"。
没有教训行的确实是 50%（冻结语料 1,546 次里 767 次），但其中 340 次带的是 Read→Edit 提醒
（`[mem] ⚠ Lessons #N were shown when you Read X — <指令>`），它点名教训 id 并重复整段指令。
真正只有抬头 + 文件信息行的是 426 次（27.6%）。

## 基线（冻结语料，52 会话）

全部 hook 25.24 KB/会话，本插件 **18.57 KB/会话**（73.6%），其他插件 6.67（其中 0.22 是另一个插件
Stop 钩子的阻断反馈，记录类型是 `hook_blocking_error`，只算反馈正文 `blockingError.blockingError`；
初稿漏算了这一类，读成 25.02 / 74.2%。说法评审连同渲染时的包装和命令一起算，读成 0.28 / 25.30 / 73.4%，
两个读数的差别只在这个口径上）。

| 面 / 行类 | KB/会话 | 行数 |
|---|---|---|
| **PreToolUse**（`pre-tool-recall.js` + `-bash.sh`，1,546 次） | **9.96** | |
| 　抬头 `[mem] PreToolUse recall — …` | 2.78 | 1,546 |
| 　教训行 `#NN` / `E#NN` | 2.66 | 876 |
| 　Read→Edit 提醒（带整段指令） | 2.03 | 340 |
| 　文件信息行 `[mem] 📄 …` | 1.57 | 1,102 |
| 　`[mem] Lessons for X:` | 0.53 | 779 |
| 　编辑前指令 `⚠ Before this edit: …` | 0.38 | 73 |
| **SessionStart**（60 次） | **3.09** | |
| 　`### Recent` 表 | 1.02 | 745 |
| 　`### Last Session` | 0.86 | 256 |
| 　`### Deferred Work` | 0.59 | 297 |
| 　`### Working State (from /clear)` | 0.29 | 84 |
| 　启动面板 | 0.20 | 193 |
| 　其余（未存提醒、标签、空行） | 0.13 | |
| **UserPromptSubmit `hook.mjs user-prompt`**（41 次） | **2.24** | |
| 　会话交接 handoff | 2.09 | 549 |
| 　`<memory-context>` | 0.15 | 45 |
| **UserPromptSubmit `user-prompt-search.js`**（87 次） | **1.53** | |
| 　引用到的 deferred 全文 | 1.01 | 145 |
| 　FYI 相关记忆 | 0.32 | 135 |
| 　相似问题 | 0.20 | 104 |
| **PostToolUse `post-tool-use.sh`**（138 次） | **1.24** | |
| **PostToolUseFailure**（51 次） | **0.52** | |

handoff 内部：`<session-summary>` 1.16、`## Working On` 0.54、其余小节合计 0.39 KB/会话。

## 各面的价值（第 2 步）

### 有引用信号的面：被引用率

`citation-live-replay.mjs`，同一冻结根。口径：分母 = (会话, id) 对，分子 = 该 id 在本会话主线程助手文本里以
`#NN` 出现（不含 `#NN n/a`）。

| 面 | 对数 | 被引用 | 引用率 | 95% CI |
|---|---|---|---|---|
| pretool | 332 | 3 | 0.9% | [0.3, 2.6] |
| error_recall | 366 | 1 | 0.3% | [0.0, 1.5] |
| fyi | 93 | 1 | 1.1% | [0.2, 5.8] |
| ups | 14 | 1 | 7.1% | [1.3, 31.5] |

这份语料里被引用的教训只有 4 个（不同的 (会话, id) 对）。上表按面相加是 6，因为会话 `2b427c71` 里对 `#210`
的一次引用在 pretool、error_recall、fyi 三个面上各算一次（三个面都注入过它；初稿写成"合计 6 次引用"，发版前评审指出）。
任何改动前后的引用率差异都会落在置信区间里，所以引用率在这里
**不能当判定指标**，只能作为结构约束：改动不删教训行、不删要求引用的指令，(会话, id) 对就一对不少。

### 没有引用信号的行：代理指标（`--value`）

- **文件信息行**（1,102 行）。按它所附着的那次调用分：`sed -n`/`grep` 等部分读取 949、Read 带
  offset/limit 42、整读 Read 63、`cat` 等整读 48。也就是 89.9% 附着在**已经决定了切片**的调用上。
  （按命令里提到这个文件的那段管线判断；初稿按整条命令判断，`cat a; sed -n … b` 这类整读 a 的
  调用被算成部分读取，读成 975 / 22 / 92.3%。）
  官方文档（code.claude.com/docs/en/hooks，"Add context for Claude"，2026-10-16 读）写明
  PreToolUse 的 additionalContext 放在 "next to the tool result"，模型在下一次请求才读到，
  所以这一行改变不了它附着的那次调用。之后同一回合是否又切片/grep 同一文件：整读 Read 之后 34.9%
  （22/63），Bash 部分读之后 69.1%（656/949）——整读之后切片反而更少，看不出这一行促成切片。这个代理
  会把"后面某条提到该文件且带 `tail` 的命令"（如测试输出 `| tail`）也算成切片，是偏高的计数。助手文本提到文件大小：
  0/1,102。没有不带这一行的对照组（功能在整个语料期都是默认开），所以这是描述性的，不是因果。
- **抬头**。语料里每个带教训的块都有抬头，没有对照组，无法从转录测它的作用。D#104 的 A/B 只比较了两种措辞
  （legacy 6/162 vs factual 2/158，p = 0.21），不涉及去掉它。官方文档建议用事实陈述，不用
  "system-injected … continue your planned action" 这类系统指令式措辞。
- **SessionStart `### Recent` 表**：表里的 id 在会话中被引用 2/498（0.4%）。
- **SessionStart `### Deferred Work`**：D#N 在会话里被助手提到 51/190（26.8%）（可能来自用户自己提到 D#N）。
- **启动面板的 `💡 mem events … activity recent`**：60 个 SessionStart 块全都带这一行；52 个会话里
  没有一个真正调用过 `activity` 命令（0/52）。初稿读成 4/52：那 4 条命令只是提到了 `lib/activity.mjs`
  之类的文件名，尺子的判断写松了，已改成只认 CLI 调用。
- **相似问题**（52 行）：P#N 被提到 0/52；8 行就是触发它的那条提示本身（`hook.mjs user-prompt` 和
  `user-prompt-search.js` 并行，前者先把当前提示写进 `user_prompts`，后者就搜到了它）；另有 1 行（`P#1003 继续`）和本会话更早的一条提示文字相同，但"继续"太短，别的会话里也有人输入过，
  无法确定是不是同一条。
- **handoff**：33 个会话出现，33/33 的 SessionStart 已经注入了 Last Session / Working State
  （这两节在这 33 个会话里共 39.47 KB）。两者来自同一行 `session_summaries` / `session_handoffs`，
  SessionStart 版截到每字段 120 字符，handoff 版是全文。
- **同一会话内重复注入同一教训**（压缩后重新计）：只看同一个面之前是否注入过，pretool 教训行 8.9%
  （78/876），error_recall 19.0%（89/468），fyi 7/100，合计 0.55 KB/会话；把三个面合起来算（之前任一
  面注入过就算重复），是 12.7%（111/876）、29%（137/468）、8/100，约 0.8 KB/会话。

## 本文的局限

- 引用率样本太小（上面 4 个被引用的教训），"改后引用率不降"只能从结构上保证，不能在这份语料上测出来。
- 代理指标都是观察性的，没有对照组。
- `pretool_agent`（子代理提示改写）在语料里 0 次，没有数据。
- `citation-live-replay.mjs` 说 SessionStart 不留转录痕迹（`keyctx` 不可回放）；这份语料里 SessionStart
  的 stdout 是作为 `hook_success` 记下来的（60 次）。语料里没有 Key Context 节（采用了插件的项目会静默它），
  所以这条没有在这里验证，留作后续。
