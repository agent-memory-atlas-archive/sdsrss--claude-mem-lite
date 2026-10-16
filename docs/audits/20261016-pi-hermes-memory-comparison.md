# pi-hermes-memory 对照调研与采纳建议（2026-10-16）

- **对象**：[chandra447/pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory)。读的是 `main` @ `24fcd8a`（2026-10-11），对应 npm 0.9.10。它是 Pi 编码 agent 的扩展，移植自 Nous Research 的 Hermes agent。2026-10-16 通过 `gh api` 读到：487★、128 fork、37 个未关闭 issue。
- **本仓**：`main` @ `862cb447`（v6.27.0）。**语料**：本机 `~/.claude-mem-lite/claude-mem-lite.db`，只读，2026-10-16T08:42Z 读取。live observation 383 条（`liveObsFilterSql` 口径），events 6,599 条，session_summaries 455 条，user_prompts 1,070 条（2026-09-05 → 2026-10-16）。
- **方法**：
  - 读源码约 1.8 万行 TS，重点是 `correction-detector.ts`、`content-scanner.ts`、`constants.ts`（全部提示词）和 `pi-child-process.ts`；README 全文；84 个 issue 的标题，其中 4 个读了全文和评论。
  - 对照本仓代码，给出 `file:line`。
  - 在本仓语料上跑 4 个只读探针。脚本放在 scratchpad，没有入库；口径写在 §3。
- **性质**：建议书，不是实现记录。和 [2026-09-27 同类项目调研](20260927-oss-landscape-optimization-proposal.md) 是同一套写法。那份文档已经否决过的方案，本文不再重提，除非拿到了新证据。

---

## 0. 结论先行

**pi-hermes-memory 的功能，我们大部分已经有，而且有几项做得更严。它最有价值的部分不是功能表，而是 issue 区。**

它的默认设计和我们几乎相反：默认**不注入**，只往系统提示里放一段"什么时候该去搜记忆"的策略文字；后台由 LLM 合并、删改记忆；agent 可以自己创建技能。随后，它的 issue 区按时间先后记录下了这几条路线各自的代价。这相当于一个独立的自然实验，**印证了本仓 5 个已经做出的设计决定**（§6）。

初稿里唯一的候选 R1，已经按它自己写好的尺子测过（§9），**结论是不做**：

| # | 建议 | 补哪块短板 | 测量结果（§9） | 结论 |
|---|---|---|---|---|
| R1 | 跨项目召回 `scope='environment'` 的教训（对应 pi 的"全局层 + 项目层"） | 82 条标成"跨项目适用"的教训，没有任何检索路径会跨项目召回；Claude Code 原生 auto memory 也按项目隔离 | 6 周、7 个项目里只确认 2 例跨项目重复学习；即使用最有利的设定重放当时的真实报错，早先那条教训也没有一次在相关时刻进入注入名额（A 对 3/30 进了前三，3 次全是无关报错；B 对 0/8）；同项目对照：#220 被真实注入过 12 个会话，引用 0 次，同类缺陷照样再次出现 | **停**，触发了第 2 步的停手条件。卡住召回的是"报错里的症状词"和"教训里的诊断词"对不上，不是项目隔离 |

pi #226 那一类风险（自动捕获把记忆从工具输出里回灌成新记录），在我们这里也测了（§9.3）：机制存在，但 1,057 条带引文的 event 里，读取时的回声是 0 条。**不改**。

**明确不采纳**（§5，每条都有证据）：
- 默认不注入、按策略拉取（policy-only）；
- agent 自动创建技能（procedural skills）；
- 正则写入黑名单扫描器；
- 用户纠错检测；
- LLM 合并或删改记忆；
- trigram 分词；
- 会话全文检索 `session_search`；
- 常驻指令文件 STANDING.md。

---

## 1. pi-hermes-memory 是什么

| 组成 | 做法 | 出处 |
|---|---|---|
| 存储 | `MEMORY.md` / `USER.md` / 项目级 `MEMORY.md`，每个文件 5,000 字符上限，条目用 `§` 分隔；SQLite FTS5（trigram 分词）做镜像和检索 | README "Where Data Lives"、"Known Limitations" |
| 注入 | 默认 `memoryMode: policy-only`：系统提示里只放 `<memory-policy>`，教模型什么时候调用 `memory_search`；`legacy-inject` 是旧行为（整份注入） | README 第 177、190 行；`constants.ts:111` |
| 常驻 | `STANDING.md`：只有用户能写（编辑器或 `/memory-pin`），后台流程一律不写，上限 20 条 / 2,000 字符，每个会话都注入 | README "Standing Instructions" |
| 写入 | 主模型调用 `memory_add` / `memory_replace` / `memory_remove`；replace 和 remove 按**子串**定位条目 | README "Memory write tools" |
| 后台学习 | 每 10 轮或 15 次工具调用，调一次 LLM 复盘；会话压缩前、会话结束时各再 flush 一次 | README "Tool-Call-Aware Review"；`constants.ts:243` |
| 纠错检测 | 英文正则分两遍：强模式直接命中；弱模式（如 `^no,`）后面要跟指令词才算；另有负模式排除 | `correction-detector.ts`；`constants.ts:352-405` |
| 写入扫描 | 11 条注入 / 外泄正则、20 条密钥正则、10 个隐形字符，命中就**拒绝写入** | `content-scanner.ts` |
| 技能 | `skill_manage` 工具写 `SKILL.md`；一轮里用了 8 次以上工具、涉及 2 种以上工具，就问模型"要不要存成可复用流程" | README "Skill Auto-Extraction" |
| 会话检索 | 把 Pi 的会话 JSONL 建成 FTS5 索引；可选 `anchors` 模式，直接读 JSONL，只返回 `path:起止行` | README "Session History Search" |
| 子进程 | 后台的 `pi -p` 只放行 3 个写记忆工具，并且 `--exclude-tools mcp__*` | README "Direct-Transport LLM Calls"；#275 |

---

## 2. 逐项对照

| pi 的能力 | 本仓现状 | 判定 |
|---|---|---|
| policy-only：不注入，让模型自己去搜 | 在动手的那一刻推送：PreToolUse、error-recall、UPS、SessionStart。近 7 天 PreToolUse 引用率 56.2%（68/121），是各注入面里最高的（2026-09-27 那份文档 §1.1） | **我们的路线更好**，§5.1 |
| STANDING.md 常驻指令 | Claude Code 原生的 `CLAUDE.md` / `CLAUDE.local.md` / `.claude/rules` 就是这个机制 | 宿主已提供，不做 |
| 纠错检测 | 没有 | 不做，§3.2 |
| 每 N 轮 / N 次工具调用的后台复盘 | Stop 每轮触发，episode 批处理按窗口 flush（`hook-llm.mjs`） | 等价 |
| 压缩前 flush | PreCompact 的 stdout 会成为压缩摘要器的 `newCustomInstructions`（`lib/hook-stdout.mjs:31`），我们在这时注入记忆块（`hook-precompact.mjs`）。Stop 是从磁盘上的 transcript 重扫，压缩不会丢掉我们的输入 | 用途不同，不需要 |
| 记忆满了就由 LLM 合并、删改 | 只追加 + `superseded_at`；合并时写新行、把旧行标为已取代；长时间的 LLM 调用之后，UPDATE 的 WHERE 里也带 `liveObsFilterSql` | **我们的路线更稳**，§5.5 |
| 召回次数（`hit_count`）作为合并时的平局裁决，"never removal orders" | `cited_count` / `uncited_streak` / `decay_seen_count`；D#179/D#198 起衰减循环不再写 `importance`（`lib/citation-tracker.mjs:1141`） | 结论相同，已有 |
| 写入扫描器（正则黑名单） | `scrubSecrets` 先**脱敏**再写（`lib/save-observation.mjs:193`）；LLM 输入带 `MEMORY_INPUT_GUARD`；normalize 路径用 Unicode 属性拒绝不可见字符（`hook-optimize.mjs:783`） | 不采纳黑名单，§3.1 |
| 后台子进程只放行写记忆工具 | `claude -p` 带 `--tools ''`，一个工具都不给，另加 `--strict-mcp-config`、`--setting-sources project`（`haiku-client.mjs:769`）；输入走 stdin，不走 argv | **我们更严** |
| 提示词里不放可解析的 JSON 示例（#197） | 我们的提示词里有带占位值的 JSON 示例（如 `hook-llm.mjs:966`） | 实测没有回显，§3.3，不改 |
| 技能自动创建 | 没有 | 不做，§5.2 |
| 全局层 + 项目层 | 只有项目层。`scope='environment'` 只是一个**标签**（`lib/observation-write.mjs:39`），唯一的读者是一个默认关闭的开关，作用是把这类教训从按文件触发的 PreToolUse 里**排除**出去（`tests/scope-label.test.mjs` 文件头） | **缺口**，R1 |
| trigram 分词（中文子串检索） | 在 FTS 文本后追加中文 bigram（`lib/save-observation.mjs`） | 我们的做法对两个字的中文词更好，§5.6 |
| `session_search`：会话全文检索 | `user_prompts_fts`、`session_summaries_fts`、`events_fts`、`observations_fts`；没有索引助手一侧的正文 | 不做，§5.7 |
| `/memory-preview-context` | `claude-mem-lite context`（加 `--chars` 输出它的长度和 hook 上限的比较） | 已有 |
| 自动捕获把**已删除**的记忆从工具输出里重新写回（#226） | episode 的输入只有 50/60 字符的 `desc` 加 DIAGNOSIS 行（`lib/episode-input-filter.mjs:406`）；MCP 的 `mem_*` 工具在 PostToolUse 被跳过（`skip-tools.mjs:30`） | 结构上暴露面小得多。Bash 调 CLI 读记忆（`cli.mjs get/search`）的输出没有被排除；实测读取时回声 0 条，见 §9.3 |

---

## 3. 本次实测（2026-10-16，本机语料，只读）

### 3.1 把 pi 的写入扫描器原样跑在我们库上

正则从 `content-scanner.ts` @`24fcd8a` 逐字复制。总体：**8,913 行里，pi 会拒绝 17 行，人工逐条读过，17 条全部是误报；真正的命中是 0。**

| 表（口径） | 行数 | pi 会拒绝 | 命中分布 |
|---|---|---|---|
| observations（live） | 383 | 0 | — |
| events（未取代） | 6,599 | 4 | 环境变量**名**：`GITHUB_TOKEN` ×2、`ANTHROPIC_API_KEY` ×2、`OPENROUTER_API_KEY` ×1 |
| session_summaries | 455 | 2 | `ANTHROPIC_API_KEY` 这个名字 ×2 |
| user_prompts | 1,070 | 11 | 用户自己在描述 `~/.ssh` 配置（P480–P484），还有提到 `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` 的名字 |

还有两项检查，结果都是 0：
- **高危密钥正则 0 命中**。这把外部尺子同时反证了本仓的 `scrubSecrets` 没有漏掉真实密钥。
- **隐形字符和 bidi 控制符 0 命中**：pi 的 10 个隐形字符、它漏掉的 U+2066–U+2069 bidi 隔离符，以及 `\p{Default_Ignorable_Code_Point}`，都没有出现。

**结论**：它的"中危"规则会拦下环境变量名。本项目的网关、代理、密钥配置本身就是业务，照搬就会拒掉合法的教训，例如 #454 "doctor green on an ANTHROPIC_BASE_URL ending in /v1"。不采纳。

### 3.2 纠错检测的分母

- **总体**：1,070 条用户提示词，其中含中文的 894 条（83.6%）。不到 20 字的短句也都存着（474 条，比如"继续""授权"），所以分母没有被过滤过。
- **pi 的英文两遍规则**：命中 0 条。
- **中文开头规则**（`不对|不是|错了|你又|我说过|我说的是|应该是|别再|不要再…`，再加前 200 字内的同类短语）：命中 1 条。P602："我说的是借用这种思想，不是说把其它的都删掉……"，人工判定确实是纠错。

**结论**：1/1,070，这个分母支撑不起一个检测器。**总体的局限**：这些提示词来自同一位重度用户，也就是维护者本人；其他用户的纠错频率可能更高。即便如此，Claude Code 原生的 auto memory 已经负责记录纠正（feedback 类），再做一个就是重复写入，见 §5.4。

### 3.3 提示词里的 JSON 示例有没有被模型照抄回来（pi #197 那一类）

- **方法**：取本仓提示词里的 17 个占位串，比如 `concise ≤80 char description`、`kw1`、`specific fact 1`、`alt query 1`、`what the user was working on`，在所有存储文本里做子串匹配。
- **总体**：observations 406 行（全部行，不只 live）、events 6,599 行、session_summaries 455 行。
- **结果**：三张表都是 **0**。
- **阳性对照**：同一条查询换成 `hook`，命中 116 / 878 / 67，说明这把尺子能说"有"。
- **结论**：不需要改。

### 3.4 跨项目重复学习（R1 的前提）

- **方法**：在不同项目的 live observation 之间两两计算 Jaccard（标题 + lesson 的词集合，中文用 bigram）。总体是 379 行，排除了 `worktrees--*` 和 `scratchpad--*`。
- **结果**：阈值 0.2 时 0 对；0.1 时 5 对，人工读过，没有一对是同一条教训。
- **这把尺子是盲的，结果不能当"没有重复"来读**。人工找到的一对：
  - 2026-09-21，`dev--gsd-lite` 的 **#176**："GIT_DIR in a test env corrupts the parent repo index"；
  - 2026-09-26，`dev--claude-mem-lite` 的 **#297**："Inherited GIT_DIR from pre-commit turns the shared repo bare when committing from a worktree"。

  两条根因相同（子进程继承 `GIT_*`，污染父仓库），修法也相同（在子进程里剥掉 `GIT_*`），五天后在另一个项目又学了一遍。可这一对的 Jaccard 低于 0.1，词法探针根本看不到它。
- **同项目也有重学**：`dev--claudemd` 里，#220（2026-09-25，"grep -q + pipefail = SIGPIPE flake under load"）和 #471（2026-10-07，"printf|grep -q under pipefail lost deny-side matches to SIGPIPE"）是同一个机制。这说明问题不只是"跨项目搜不到"，触发时的词汇和教训里的词汇对不上，同一个项目里也会漏召回。
- **`environment` 标签的精度**：我读了最近 40 条 `type=bugfix AND scope=environment` 的 live 行，判断 24 条确实跨项目适用。例如 #393 "`node --test test/` exits 1 on Node 22/24"、#541 "ssh 'bash -s' < script: docker compose exec -T still swallows the rest"、#536 "signal.signal + asyncio.Event does not wake the loop"。另外 16 条其实只属于本项目，例如 #480 code-graph-mcp 的发布步骤、#454 本仓的 doctor 判定。**只有一个人读过，没有做盲评**。
- **live 行里 `scope='environment'` 的分布**：bugfix 53（其中 importance≥2 的 51）、decision 16、discovery 8、change 5，共 82 条，占 383 条 live 行的 21%。

---

## 4. 建议

### R1 · 跨项目召回 `scope='environment'` 的教训

> **2026-10-16 已按下面的尺子测过，第 2 步触发停手条件，不做。** 数据和推理见 §9.1–§9.2。下文保留的是初稿的论证，供以后重开时对照。

**问题**：工具和环境层面的怪癖（Node 版本差异、bash 管道语义、git 环境变量、代理行为）不属于哪一个项目，但我们的检索路径全部按项目隔离：
- error-recall：`WHERE … AND o.project = @project`（`lib/error-recall-core.mjs:160`）；
- UPS 的跨项目阶段只放行 `o.type IN ('decision', 'discovery')`（`hook-memory.mjs:408`），bugfix 进不去，而 environment 标签里最多的正是 bugfix（53/82）；
- 按文件触发的 PreToolUse 天然只对应本项目的文件。

Claude Code 原生 auto memory 也按项目存放：本会话的记忆目录就是 `~/.claude/projects/-home-ai-dev-claude-mem-lite/memory/`。所以这一块宿主也没有覆盖。

**证据**：
- 外部：pi 和 Hermes 都把"跨项目的工具行为"单独放在全局层（`constants.ts:111` 的 target routing："memory: … cross-project tool behavior"）。
- 本仓：§3.4 那一对人工确认的重复学习，以及 82 条已经由 LLM 标成 `environment` 的教训。
- **强度弱到中**：重复学习只有一例是确认过的，标签精度只有一个人读过。

**设计**：只放开两个面，按文件触发的 PreToolUse 不动。D#65 测过，environment 教训在那个面上被跳过得最多，那里的默认开关就是把它们排除掉。
1. UPS 第二阶段：谓词改成 `(o.type IN ('decision','discovery') OR o.scope = 'environment')`，仍然要求 `importance >= 2`，并保留原有的 low-signal 和 live 过滤。
2. error-recall：增加一条跨项目的腿，只取 `scope='environment'`，最多 1 个名额，bm25 下限比同项目那条腿更严。

注入行里标明来源项目，例如 `[from dev--gsd-lite]`。模型据此能判断这条是不是适用；citation 也能按"同项目 / 跨项目"分开统计。

**尺子与停手条件**（按顺序，前一步不过，后面就不做）：
0. **先读现有那条跨项目腿的引用率**。UPS 第二阶段已经在跨项目注入 decision/discovery，要按"同项目 / 跨项目"拆开它的 cite rate，口径用 `citation-live-replay.mjs`。如果跨项目这一侧的引用率远低于同项目，说明模型不采纳别的项目来的记忆，R1 就停。
1. **建重学对照集**。词法探针测不出这类重复（§3.4），只能人工或借助 LLM：对每条 environment bugfix，去其他项目的语料里找同根因的早期教训。**对照集少于 5 对就停**：分母撑不起结论。
2. **到达率**。用对照集里**后一次**会话的真实触发（transcript 里的报错文本、用户提示词），重放跨项目这条腿，看早期那条教训能不能进入注入名额。这一步要观察分支实际执行了，不能靠推断。**到达率低于一半就停**：那说明问题出在触发词和教训词汇对不上（§3.4 的同项目重学也是这个症状），不在项目隔离；那是另一件事。
3. **标签精度**。对 82 条 environment 行做两人盲标。**精度低于 0.7 就先改标签**，再考虑放开。
4. **噪声与预算**。用 `error-recall-suite.mjs` 和 `denoise-ab.mjs` 确认同项目各个面没有退化；用 `injection-budget.mjs` 在冻结语料上量每个会话多出的字节数，因为 v6.27.0 刚把注入量从 18.57 KB/会话降到 12.66 KB/会话。

**风险与级别**：
- 跨项目注入，等于把 A 项目的私有路径和命名带进 B 项目的会话；数据是同一个用户、同一台机器上的，但会增加误用的可能。来源标注是对这一点的缓解。
- 改的是已发布插件的默认注入行为，按规范属于 **L3**：要先写 spec。实现时先做成默认关闭的开关，A/B 过了尺子之后再讨论改默认值。

---

## 5. 明确不采纳

### 5.1 policy-only（默认不注入，让模型自己去搜）

pi 自己的 issue 区记录了这个默认值的代价：
- **#121**（已关闭）：用户反复说"不要跑 `find /`"，这条规则在 `USER.md`、`MEMORY.md`、`failures.md` 和 SQLite 四处都存下了，模型还是在没调用 `memory_search` 的情况下又跑了一次。作者的回复是 "The design is what's wrong"，于是加了 STANDING.md（#147）。README 自己也写着："for a prohibition, that is exactly the moment it has no reason to look"。
- **#231**（未关闭）：社区提议在每轮用户消息**末尾**，用 FTS5 自动取 top-K 记忆注入，理由是不破坏前缀缓存。这正是我们 UPS 面已经在做的事；PreToolUse 和 error-recall 的 `additionalContext` 也都附在对话尾部，不改系统提示。

### 5.2 agent 自动创建技能

**#287**（未关闭，2026-10-10 的实测）：
- 六周里自动创建了 63 个技能；在当时还存在的 62 个里，只有 3 个之前用户提到过 "skill"，只有 1 个是用户明确要求的。
- 在用户最常用的项目里，一个会话的系统提示里挂着 39 个技能，光目录就占 **11,961 字符**；系统提示里其他所有部分加起来才 16,947 字符。

技能目录是"常驻"的，一旦保存，以后每一轮都要付出上下文成本。这和本仓刚完成的注入减量（v6.27.0）方向相反。另有 **#107**：用 LLM 自己调用来 patch 技能文件，"40+ cases" 写坏了文件。

### 5.3 正则写入黑名单

§3.1：真命中 0，误报 17。

### 5.4 用户纠错检测

- §3.2：分母是 1/1,070，pi 的英文规则在中文为主的语料上命中 0。
- Claude Code 原生 auto memory 已经负责 feedback 这一类；本用户的全局规范也要求"用户纠正之后保存"。
- **重新评估的条件**：拿到其他用户的语料，纠错率 ≥2%，并且原生 auto memory 没有记下这些纠正。

### 5.5 LLM 合并、删改记忆

pi 在这条路上的事故记录，都是 2026-09-27 那份文档 §5 预测过的形状：
- **#170**：按子串 replace，会连带丢掉同一条目里的其他事实；
- **#177**：自动合并没有和正在工作的 agent 协调，可能改掉正在进行的写入；
- **#226**：后台捕获把**刚删掉**的 ~110 条记忆从工具输出里重新写回，分三波，有逐字重建（作者给了 SHA-1 比对）；
- **#168**：后台写入和手动写入之间没有去重；
- **#281**（未关闭）：删除不可逆，提议改成"退役而不删除"。

本仓的只追加 + `superseded_at` 路线不变。

### 5.6 trigram 分词

- pi 为了让纯中文查询能命中，从 unicode61 改成了 trigram（**#174**，已关闭）；
- 然后又碰到"多词、短的中文查询搜不到"（**#291**，未关闭）。

这和 2026-09-27 那份文档 §5 引用的官方限制一致："fewer than 3 unicode characters do not match"。我们的 bigram 方案不变。

### 5.7 会话全文检索 `session_search`

**缺口确实存在**：我们没有索引助手一侧的正文。但**没有需求证据**：用户问"上次讨论的 X"时，`user_prompts_fts`（提问本身）和 `session_summaries_fts`（结论）已经能接住；本次调研开头查 P#819 就是这样找到的。

**重新评估的条件**：opt-in 的搜索遥测（#40）里，出现"零结果，但答案确实在 transcript 里"的查询，并且一个月里 ≥10 次。届时优先考虑 pi 的 `anchors` 做法：不建索引，按需读 JSONL，只返回 `path:起止行`。它不增加存储，也不增加常驻的上下文。

### 5.8 STANDING.md 常驻指令

宿主的 `CLAUDE.md` 系列就是这个机制。不过它的**出处原则**值得记下：后台写入者永远不能把内容提升进常驻区块。本仓的 SessionStart Key Context 是按 `importance` 选的，而 `importance` 有五个写入者，其中有 LLM。

写入来源其实是可以拆开测的。初稿说"没有'谁写的'这一列，没法拆开测"，**这句是错的**：来源记在 `memory_session_id` 的前缀里，`manual-` 表示显式保存，`hook-` / `compress-` / `enrich-` / `promote-` 等表示机器写入，由 `lib/provenance.mjs` 读取。2026-10-16 的 live 行里显式保存 349 条，机器写入 36 条。目前没有证据说明常驻区块里的机器写入行造成了问题，只作观察，不立项。

---

## 6. 它印证了我们哪些既有决定（独立证据）

| 本仓的决定 | pi 走了相反的路，结果是 |
|---|---|
| 在动手的那一刻推送，不靠模型自己去拉 | #121：禁令在拉取模式下不生效；#231：社区提议改回"每轮推送" |
| 注入有字节预算；常驻内容尽量少（v6.27.0） | #287：自动技能目录在每一轮占 11,961 字符；#264：后台提示词把整份记忆塞进去，没有预算 |
| 只追加 + `superseded_at`，不让 LLM 原地改写或删除 | #170、#177、#226、#168、#281 |
| 后台 `claude -p` 不给任何工具 | #275：后台子进程曾经带着全部工具在用户仓库里运行，出现过"幽灵编辑"，后来才收紧到 3 个写记忆工具 |
| 中文用 bigram，不用 trigram | #174 → #291 |
| 启动路径上不做同步的重活 | #194 / #254：每次打开数据库都同步跑 `PRAGMA quick_check`，启动卡 ~11 s；#227：每次启动做一次全量 markdown 对账，耗时 2–7 s |
| 检索走确定性的词法路线，不上向量 | 一篇对 11 个编码 agent（含 Claude Code、Hermes、Pi）做源码分析的论文（arXiv 2609.00006，摘要）："none retrieves code with vector embeddings"；Hermes 的 `session_search` 也是纯 FTS5，"no LLM calls" |

**这些只是佐证，不是测量**：issue 是单个用户的报告，数字来自报告者本人，没有第三方复现。

---

## 7. 局限

- **语料小，而且只有一位用户**：383 条 live 记忆、1,070 条提示词，全部来自维护者本人。§3.2 的纠错率、§3.4 的标签精度，都可能带有这位用户的习惯。
- **§3.4 的尺子是盲的**：词法相似度找不到换了说法的同一条教训。R1 的第 1 步必须换一种方法，否则"0 对"会被误读成"没有问题"。
- **Bash 读记忆的回灌**：初稿把它列为"没测过的暴露面"，§9.3 已经测过。
- **本文没有做的事**：没有改代码，也没有跑 A/B。§3 和 §9 的探针都是只读的。

---

## 8. 来源

**主线程本次读过的原文**（2026-10-16）：
- pi-hermes-memory 源码 @`24fcd8a`：`README.md`、`src/constants.ts`、`src/handlers/correction-detector.ts`、`src/store/content-scanner.ts`；`git clone` 到 scratchpad，没有执行其中任何代码。
- pi issue 全文和评论（`gh issue view`）：#121、#226、#231、#287；其余 80 个只读了标题和状态（`gh issue list --state all --limit 80`）。
- pi.dev 包页面：https://pi.dev/packages/pi-hermes-memory （0.9.10，2026-10-02 发布）。
- Hermes agent：https://github.com/NousResearch/hermes-agent ；记忆文档 https://hermes-agent.nousresearch.com/docs/user-guide/features/memory （MEMORY.md 上限 2,200 字符、USER.md 上限 1,375 字符；"captured once at session start and never changes mid-session … preserves the LLM's prefix cache"；`session_search` "no LLM summarization"）。
- 论文摘要：https://arxiv.org/abs/2609.00006 （只读了摘要页）。

**本仓**：文中所有 `file:line` 都是本次读取的。探针在 scratchpad 里：`content-screen-probe.mjs`、`correction-denominator.mjs`、`cross-project-relearn.mjs`，以及 §3.3 的 sqlite3 子串查询。都以 `readonly` 打开数据库。

---

## 9. 后续测量（2026-10-16 第二轮）

这一轮测两件事：R1 按 §4 预先写好的尺子逐步测量；§7 里"没测过"的回灌风险。全部只读，数据库都以 `readonly` 打开，脚本放在 scratchpad。

### 9.1 R1 第 0 步：现有跨项目那一路的引用率

- **工具**：`benchmark/citation-live-replay.mjs --dump`，2026-10-16T09:06Z 跑一次。185 个会话 transcript，会话起始时间 2026-09-19 → 10-16。
- **拆分方法**：把每个 (session, id) 对按"被注入那一行的 project 是否等于会话所在项目"拆开。会话目录到项目名用正向匹配，`--` 和 `_` 都折成 `-`。
- **映射验证**：pretool / fyi / error_recall 三个面的 SQL 本来就按项目隔离，拆出来的跨项目对都应该是 0，结果也确实是 0。

| UPS 面 | 对数 | 被引用 | 引用率 | 95% CI |
|---|---|---|---|---|
| 同项目 | 29 | 3 | 10.3% | [3.6, 26.4]% |
| 跨项目 | 44 | 3 | 6.8% | [2.3, 18.2]% |

跨项目那 44 对，按"类型 / scope"分：decision/project 2/24，decision/environment 1/12，decision/module 0/2，discovery/project 0/6。

**读法：两个置信区间重叠，判不出来。** 更根本的问题在尺子本身：同一次遍历按 2026-09-22 切开，各面的引用率都断崖下跌：

| 面 | 9-22 之前 | 9-22 之后 |
|---|---|---|
| pretool | 47.3%（44/93） | 5.1%（34/667） |
| fyi | 25.0%（11/44） | 6.0%（16/267） |
| error_recall | 21.0%（29/138） | 3.2%（33/1046） |
| ups | 11.1%（3/27） | 6.5%（3/46） |

记忆 #465 把这次下跌归因于同一天的模型切换；本文没有独立验证这个归因。

基数只有 5% 左右时，要在 80% 的统计功效下分辨 10% 和 5%，每组大约需要 435 对。UPS 的跨项目那一路在整个语料里只有 44 对，短期内攒不够。所以改用不依赖引用的尺子：到达率。

### 9.2 R1 第 1–2 步：重学对照集，以及到达率

**对照集**：
- **方法**：在 380 条 live 行（排除 worktree / scratchpad 项目）里，按"共享罕见技术标识符"找候选对。标识符包括环境变量、命令行 flag、snake_case、信号名，且出现的文档数 ≤4。共 39 个跨项目候选对，逐条人工读过。
- **确认为同一根因的 2 对**：
  - **A**：gsd-lite 的 #176（09-21）→ claude-mem-lite 的 #297（09-26）。子进程继承 `GIT_*`，污染父仓库；修法是在子进程里剥掉 `GIT_*`。
  - **B**：loop_eng 的 #168（09-21）→ claudemd 的 #220（09-25）。`set -o pipefail` 下的 `grep -q` 提前退出，上游进程收到 SIGPIPE；修法是先存进变量，再在进程内过滤。
- **相关但不是同一根因**：#134（loop_eng）和 #212（gsd-lite），都是"在源码仓库里自测，看不到安装后才出现的缺陷"。
- **同项目内的复发**：claudemd 里 #220 → #471（10-07），次日 #477 加了 class gate。
- **这把尺子的验证**：它找回了 Jaccard 探针漏掉的两对（§3.4）。但它仍是**下限**：换了说法、又不共享标识符的重复，它看不见。

**按 §4 的停手条件，第 1 步就该停**：对照集只有 2 对，少于 5 对。第 2 步成本低，而且能回答"为什么"，所以还是测了。

**到达率**：
- **方法**：取后一个项目在"早先教训创建 → 重学教训创建"这个窗口里的全部失败和全部用户提示词。
  - 失败的筛选用线上同一套闸门：PostToolUse 走 `detectBashSignificance` → `isHardError`，PostToolUseFailure 走 `shouldRecallOnFailure`。
  - 报错召回调用线上的 `selectErrorRecall`，参数设成 `project = 早先那个项目`。这是跨项目那一路能有的最好情况：没有同项目的行和它竞争。
  - 提示词走线上的 `upsFtsQuery`。
- **两点局限**：
  - 排名用的是今天的库，失败发生之后才写入的行也参与竞争，所以"进前三"的次数是下限。
  - FTS 能否匹配不受这个影响。

| 对 | 窗口 | Bash 结果 | 被闸门放行的失败 | 能生成查询的 | 早先教训能被 FTS 匹配 | 进前三 | 其中与该缺陷相关 | 窗口内提示词 / 能匹配 |
|---|---|---|---|---|---|---|---|---|
| A（跨项目） | 5.0 d | 2,882 | 40 | 30 | 7 | 3 | **0** | 62 / 0 |
| B（跨项目） | 3.8 d | 1,435 | 58 | 8 | 4 | 0 | **0** | 37 / 0 |
| C（同项目对照） | 12.4 d | 5,237 | 71 | 40 | 16 | 2 | **0** | 105 / 0 |

- **A 对进前三的 3 次**：一次 pre-commit 的 eslint 失败（09-25），一次 `git diff` 的 echo 链以 exit 2 结束（09-22），一次 `bc: command not found`（09-22）。真正相关的那一刻是 `git config core.bare; npx vitest …`：FTS 能匹配上 #176，但没排进前三。
- **C 对的真实注入**：在 citation 导出里，#220 被线上的 error_recall 注入过 12 个 claudemd 会话（09-25 → 10-15），**被引用 0 次**；同一类缺陷在 10-07 照样再次出现。
- **提示词**：窗口内的提示词多是"继续""授权"这类简短的中文指令，和教训没有词汇交集。

**结论：停，R1 不做。** 机制层面的原因：
- 报错召回是用**失败的症状词**触发的，而能防止复发的教训，写的是**诊断和修法的词汇**。拆掉项目隔离，增加的主要是不相关的注入（A 对 3 次，0 次相关）。
- 两次复发最后都靠仓库里的确定性守卫收住：本仓 `vitest.config` 的 `tests/setup-strip-git-env.mjs`（#297），以及 claudemd 的 class gate（#477）。记忆召回在这里比不过守卫。

**重开条件**（两条都满足）：
1. 用罕见标识符探针加人工复读，确认的跨项目复发 ≥5 对；
2. 有一种按**成因的代码形状**触发的召回（例如编辑 `.sh` 文件时出现管道里的 `grep -q`，或者测试里出现 `git init`、`GIT_*`），而不是按报错文本触发；它在重放里能到达其中至少一半。

### 9.3 Bash 读记忆会不会被回灌成新记录（pi #226 那一类）

**机制确实存在**：
- `hook.mjs` 先检查输出长度（`:779`，短于 10 个字符的直接丢弃），然后把每一次 Bash 结果推进 episode 缓冲区（`:909`）；`workerEntryFields` 从输出里抽 DIAGNOSIS 行。
- 2026-10-16T09:18Z 实测：211 个 transcript、36,903 次 Bash 结果里，读记忆的调用（CLI 读命令，或 sqlite3 直接读库）有 257 次，占 0.70%。
- 其中 52 次（20.2%）经线上函数抽出了至少 1 行 DIAGNOSIS。`get` 最多，27/96：旧教训正文里带 "failed" / "error" 的行，会被当成诊断行挑出来。

**端到端发生率**：
- **event 引文**：带开头逐字引文的 event 有 1,086 条，其中引文 ≥4 个词的 1,057 条。
  - 引文出现在更早的 observation 正文里的：2 条（0.19%）；出现在更早 event 的教训正文里的：0 条。
  - 这 2 条**都来自写入时，不是读取时**：E#5126 在 `cli.mjs save` 存下 #390 之后 13 秒生成；E#5544 引用的那句话，先由一次提交命令和 `cli.mjs save`（#425）带进 transcript，之后才生成这条 event。追溯到"读记忆调用"的是 0 条。
- **已取代的行**：在取代 1 小时以后又出现在任何新行里的，0/22。正对照：把取代它的那一行放回比较范围，能找到 13/22，说明这把尺子能说"有"。
- **已删除的行**：2026-09-27 删除前的备份里，被删的只有 1 行，0/1。这个总体太小，说明不了什么。
- **本会话**：前面几十次 Bash 调用打印过记忆原文，截至 09:00 产生的 2 条 event 都没有引文。

**结论：现在不改。** 把读记忆的调用排除出缓冲区，成本不高，但防的是一个没有观测到的情况。

**重开条件**：重跑同一个引文探针，读取时的回声达到每 500 条带引文的 event 至少 1 条；或者 DIAGNOSIS 行的挑选规则改了。

**确实存在的是"保存时复述"**：
- **来源**：`lib/episode-input-filter.mjs:68` 的叙述规则是**故意**把 `cli.mjs save` 留在窗口里的（注释说那是"窗口里最有用的文字"）。
- **测量**：349 条 live 显式保存里，270 条在 −1 到 +15 分钟内有同项目的 event。按"标题词被包含的比例 ≥0.6"标出 10 对，人工读下来（只有我一人判读）8 对是同一事实的复述：#329/E#4485、#390/E#5126、#430/E#5557、#495/E#5924、#530/E#6310、#545/E#6466、#547/E#6476、#562/E#6606，最后一对就是本次调研自己产生的。
- **规模**：下限 8/349 = 2.3%。
- **代价**：同一个事实变成两条可注入的行。两条会不会被注入到同一个区块里，本次没有测。

**不建议现在处理**。2026-10-16 已经直接测过：这 8 对在同一个注入块里一起出现 0 次，同一会话里一起出现过的只有 2 对（共 3 个会话），见 [引用信号的消费者](20261016-citation-regime-consumers.md) §5。**关掉**。

### 9.4 方法备注：两次尺子事故，都被对照组抓住了

1. **FTS5 的 rowid 过滤失效**：`… WHERE fts MATCH ? AND rowid = ?` 两个参数都用绑定值时，better-sqlite3 自带的 SQLite 3.53.4 会**忽略 rowid 过滤**，返回第一条匹配。
   - 最小复现：3 行数据，查 `'alpha'` 且 rowid=2，返回的是 1 和 3。
   - 对照：rowid 写成字面量时正确；JOIN 写法正确；系统自带的 sqlite3 3.46.1 用字面量也正确。
   - 本仓早就踩过这个坑（`hook-episode.mjs:397`）；搜索线上代码，没有"FTS MATCH 加绑定的 rowid"这种写法，都是 JOIN。
   - 我第一次跑到达率时读出"8/8 能匹配"，就是这个原因，负对照（id 544、id 1 也"匹配"）抓住了它。
2. **本机 Bash 工具里的 `grep` 不是 grep**：它是一个包着 ugrep 的 shell 函数，带 `-I`，ugrep 判为二进制的文件会被**静默跳过**。`benchmark/citation-live-replay.mjs` 就被判成了二进制，`grep -n` 什么都不返回。要用 `command grep -a`。

**本节探针**都在 scratchpad 的 `probe/` 下：`cross-project-cite-split.mjs`、`cross-project-rare-token.mjs`、`relearn-reach.mjs`、`echo-incidence.mjs`、`retired-rematerialize.mjs`（正对照：`retired-posctl.mjs`）、`resurrection.mjs`、`cli-read-diag.mjs`、`save-event-contain.mjs`。
