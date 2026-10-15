# D#332 key-events-input-replay 与正式钩子对齐（2026-10-15）

问题（D#332）：`benchmark/key-events-input-replay.mjs` 的文件头说它用的是正式的闸门函数，"只导入，不复制"。
但它给每个 episode 条目算 worker 字段（`inputTags`、`diag`）的方式和 `hook.mjs` 不同：

1. 不截 64 KiB 窗口，直接在完整输出上算；
2. 不传 `scrub: scrubSecrets`，诊断行没有脱敏；
3. 不带 `diagOut`。

另外，`extractFileTargets` 没收到 `projectDir`，`desc` 也没脱敏。所以这个尺子以前的读数，测的并不是正式管线的行为。

## 改动

- 条目字段改为调用 `workerEntryFields(tool, input, resp, {isError, writesFiles, scrub: scrubSecrets})`，
  和 `hook.mjs` handlePostToolUse 是同一个函数、同一组参数。
- `desc` 经 `scrubSecrets` 处理，和 `hook.mjs` 一致。`--names` 打印的 `command` 也经过脱敏：这些名单会被贴进审计文档。
- `replayWindows(stream, project, { projectDir })` 把 `projectDir` 传给 `extractFileTargets`，
  对应 `hook.mjs` 里传的 `inferProjectDir()`。

## 测量

**输入冻结**，三个版本读的是完全相同的输入：

- 语料：`~/.claude/projects/-home-ai-dev-claude-mem-lite` 下 `collectStream` 会读到的文件，
  即 50 个主 transcript 加 199 个 subagent transcript，共 441.5 MB，复制到 scratchpad；
- 数据库：用 better-sqlite3 的 `backup()` 拷出一份；
- 项目：`dev--claude-mem-lite`，`projectDir` = `/home/ai/dev/claude-mem-lite`；
- 时间：2026-10-15；代码树 `2eeaafed` 加本次改动。

流事件 24869 个，重建出的窗口 1671 个，`events` 行 1817 条。

**三个版本**：

- before：`2eeaafed` 上的原版；
- B：只改用 `workerEntryFields`，同时给 `desc` 和 `command` 脱敏；
- C：在 B 的基础上再传 `projectDir`。

每个版本都跑了两样东西：

- 一个 scratch 脚本：调用这个尺子导出的 `collectStream` / `replayWindows` / `matchEvents` / `fateOf`，
  记下每条事件、每个窗口的结果。窗口用"时间戳 + 文件集合"作键，记录结果、标签串和诊断行数；
- 尺子自己的命令行：`--labels docs/audits/20260925-200912-session-history-analysis.md --sample 30 --seed 20260926 --json`，
  另外分别加 `--names probe`、`--names slip` 各跑一次。

| 对比 | 事件结果变化 | 窗口结果变化 | 窗口标签变化 | 窗口诊断行数变化 | probe / slip 名单 | `--json` 报告（去掉 stamp） |
|------|------|------|------|------|------|------|
| before → B | 1 | 0 | 0 | 0 | 相同（106 / 38 行） | 相同 |
| B → C | 0 | 0 | 0 | 0 | 相同 | 相同 |

唯一变化的是 **#4637**：`kept:grounded` → `demoted:ungrounded`（标题 "Private block/PEM key crossing tail window edge
leaves unpaired tags"）。

原因是脱敏，不是截窗口：

- 这个窗口里有 3 条诊断行，是一段讲 `` `<private>` `` 跨窗口边界的代码注释。存下来的 lesson 引的正是这段注释；
- `scrubSecrets` 把 `<private>` 开标签之后的文字整段换成了 `[redacted]`，
  所以改版后 `quotedLines(lesson, diag)` 是 `[]`，原版能找到 3 条。

正式钩子存诊断行时同样会脱敏，所以新读数才是正式管线实际会做的事。

**各项改动在这份语料上触发到了没有**：

- 64 KiB 截窗：触发 0 次。24581 个工具事件里没有一个输出超过 65536 字节，
  transcript 里存的工具输出本身已经被 Claude Code 截短过。所以截窗这一项只能靠"调用同一个函数"保证一致，没有实测到；
- `projectDir`：只在项目本身位于 `/tmp/` 下时才影响 `isScratchCommandPath`。这个项目不在 `/tmp/` 下，所以 B → C 为 0，和预期一致；
- 脱敏：触发了，就是上面那 1 条。

## 口径

改动前后读数**可以接着比**，唯一的例外是会碰到脱敏的诊断行：

- 这份语料上，1096 个能匹配到窗口的事件里，只有 1 个（0.09%）结果不同；
- 30 条标注事件和 seed 20260926 抽出的 30 条样本，读数完全没变。

如果某个语料里有大量诊断行带 `<private>`、密钥形状的文字，或超过 64 KiB 的输出，
差异会更大，那时要重新做一次背靠背对比。

## 顺带发现：可达性自检在当前语料上必然失败（两版相同，与本次改动无关）

尺子的自检 2 要求至少 80% 的事件能匹配到窗口。这次读到 1096/1817 = 60.3%，退出码是 1。

拆开看：

- 721 条没匹配上的事件里，有 688 条创建时间早于语料里最早的事件（2026-09-21T18:14Z）。
  那些会话的 transcript 已经被 Claude Code 清理掉了；
- 只看语料时间范围内的事件，是 1096/1129 = 97.1%。

也就是说，这个自检的分母包含了 transcript 已经不存在的事件，
只要 Claude Code 清理过旧 transcript，它就一定报失败。修法是把分母限定在语料时间范围内，
这次没改，已记为延后项。
