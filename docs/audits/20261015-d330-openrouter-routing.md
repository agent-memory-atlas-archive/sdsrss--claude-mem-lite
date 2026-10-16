# D#330 OpenRouter 路由探针（2026-10-15，v6.26.0 之后）

问题（D#330）：OpenRouter 上服务 `anthropic/claude-haiku-5.5` 的端点里，有的不列 `structured_outputs`。
请求如果被路由到这些端点，rewrite 的 json_schema 可能被忽略，单词查询又会答成散文。候选修法是
`provider: {require_parameters: true}`。

## 结论

1. **候选修法照原样会让每次调用都失败。** 请求体照旧带 `temperature: 0` 时，`require_parameters: true`
   在 72 次调用里 72 次返回 HTTP 404 "No endpoints found that can handle the requested parameters"：
   10 个端点里没有一个列出 `temperature`（下面的端点表）。去掉 `temperature` 后同样的请求 72/72 正常。
   所以 haiku-client 对 strict slug 不再发 `temperature`（和直连 API 一致），但没有加 `require_parameters`。
2. **这台机器测不出 Bedrock 会不会忽略 schema。** 账号的 allowed-providers 设置只允许
   openai / anthropic / google-ai-studio，所以指定 `amazon-bedrock` 或 `claude-on-aws` 的两组都是
   72/72 HTTP 404（OpenRouter 的报错原文见下），不带 `provider` 的请求 72/72 都由 Anthropic 端点应答。
3. **v6.26.0 的 OpenRouter 读数都来自 Anthropic 端点**，前提是这个账号设置当天没有变过（之前的
   A/B 和回放都没有记录 provider）。默认账号会在 Google Vertex、Azure、Claude Platform on AWS、
   Amazon Bedrock、Anthropic 之间负载均衡，那四家的表现这些读数一概不能说明。
4. OpenRouter 文档（provider-selection 页，2026-10-15 读）说 `tools`、`response_format`（含结构化输出）、
   `verbosity` 是选 provider 时的软偏好：模型的 provider 里只有部分支持时，请求只发给支持的那些。
   Bedrock 列了 `response_format`，没列 `structured_outputs`，这条软偏好按哪一个算，文档没写。
   D#330 保持未决（之后改记为 D#331）：需要一个没有 provider 限制的账号来测，而且修法要先去掉 `temperature`。

## 端点表（`GET /api/v1/models/anthropic/claude-haiku-5.5/endpoints`，2026-10-15T22:2xZ，无需 key）

| provider | tag | 输入单价 | 列 structured_outputs | 列 temperature |
|---|---|---|---|---|
| Google | google-vertex/global | 0.10 | 是 | 否 |
| Claude Platform on AWS | claude-on-aws | 0.10 | 否 | 否 |
| Azure | azure/global | 0.10 | 是 | 否 |
| Anthropic | anthropic | 0.10 | 是 | 否 |
| Amazon Bedrock | amazon-bedrock | 0.10 | 否 | 否 |
| Google | google-vertex/europe | 0.11 | 是 | 否 |
| Google | google-vertex/us | 0.11 | 是 | 否 |
| Azure | azure/us | 0.11 | 是 | 否 |
| Amazon Bedrock | amazon-bedrock/us-east-1 | 0.11 | 否 | 否 |
| Amazon Bedrock | amazon-bedrock/eu-west-1 | 0.11 | 否 | 否 |

（单价为每百万 token 美元。）

## 方法

探针走发布代码：`callModelJSONAsync(buildRewritePrompt(q), 'haiku', {maxTokens: 400, jsonSchema:
REWRITE_JSON_SCHEMA})`，和 deep-search 的 `callRewriteLLM` 一样。一个 fetch 包装器截下 haiku-client
自己构造的请求体，只按组加上 `provider` 字段（`req-params-no-temp` 组另外删掉 `temperature`），再经仓库
自己的 `postViaConnectProxy` 发出去。`CLAUDE_CODE_PATH` 指向不存在的文件，挡住 CLI 兜底。样本是
`haiku-model-ab.mjs` 的 24 条 rewrite 查询（三个 fixture 查询集，`pickEvenly`），每条 3 次，6 组共
432 次调用，2026-10-15T22:33–22:44Z。探针在 22:32:47Z 启动，启动时加载模块，之后的编辑不影响这一轮。启动时 HEAD 是
`3d975c32`（v6.26.0 的 release 提交）。那个会话的 transcript 里，对 haiku-client.mjs 的第一次 Edit 在 22:35:46Z，
`65a09c6a` 在 22:36:58Z 提交。用别的方式改过的文件不在这个记录里，所以"启动时工作树没有改动"无法完全证实。
不过读数不受影响：`65a09c6a` 只改了应答的处理，本轮 as-shipped 组 72 次都是正常结束，用不到那段代码；
`bfd77396` 不改基础 slug 的请求体。"bad" 表示 `assembleVariants` 少于两个变体。

## 输出（run1.log，原样）

~~~~text
{"arm":"as-shipped","n":72,"bad":0,"http":{"200":72},"providers":{"Anthropic":72},"badByProvider":{}}
{"arm":"bedrock-only","n":72,"bad":72,"http":{"404":72},"providers":{"(none)":72},"badByProvider":{"(none)":72}}
  last err: {"message":"No allowed providers are available for the selected model. Providers serving anthropic/claude-haiku-5.5-20261007: google-vertex, claude-on-aws, azure, anthropic, amazon-bedrock, but your account's allowed-providers setting permits only: openai, anthropic, google-ai-studio. To change your allowed providers, visit: https://openrouter.ai/settings/privacy. Additionally, your request's provider.only preference permits only: amazon-bedrock.","code":404,"metadata":{"available_providers":["google-vertex","claude-on-aws","azure","anthropic","amazon-bedrock"],"requested_providers":["openai","anthropic","google-ai-studio","amazon-bedrock"],"routing_funnel":[{"step":"Initial Endpoints","endpoint_count":10},{"step":"Filter by Regional Surcharge","endpoint_count":5}],"failed_routing_step":"Filter by Allowed Providers"}}
{"arm":"aws-platform-only","n":72,"bad":72,"http":{"404":72},"providers":{"(none)":72},"badByProvider":{"(none)":72}}
  last err: {"message":"No allowed providers are available for the selected model. Providers serving anthropic/claude-haiku-5.5-20261007: google-vertex, claude-on-aws, azure, anthropic, amazon-bedrock, but your account's allowed-providers setting permits only: openai, anthropic, google-ai-studio. To change your allowed providers, visit: https://openrouter.ai/settings/privacy. Additionally, your request's provider.only preference permits only: claude-on-aws.","code":404,"metadata":{"available_providers":["google-vertex","claude-on-aws","azure","anthropic","amazon-bedrock"],"requested_providers":["openai","anthropic","google-ai-studio","claude-on-aws"],"routing_funnel":[{"step":"Initial Endpoints","endpoint_count":10},{"step":"Filter by Regional Surcharge","endpoint_count":5}],"failed_routing_step":"Filter by Allowed Providers"}}
{"arm":"anthropic-only","n":72,"bad":1,"http":{"200":71,"no-request":1},"providers":{"Anthropic":71,"(none)":1},"badByProvider":{"(none)":1}}
{"arm":"req-params","n":72,"bad":72,"http":{"404":72},"providers":{"(none)":72},"badByProvider":{"(none)":72}}
  last err: {"message":"No endpoints found that can handle the requested parameters. To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection","code":404,"metadata":{"routing_funnel":[{"step":"Initial Endpoints","endpoint_count":10},{"step":"Filter by Regional Surcharge","endpoint_count":5},{"step":"Filter by Allowed Providers","endpoint_count":1,"reason":"not in your account's allowed-providers setting"}],"failed_routing_step":"Filter by Parameters"}}
{"arm":"req-params-no-temp","n":72,"bad":0,"http":{"200":72},"providers":{"Anthropic":72},"badByProvider":{}}
rows -> /tmp/claude-1000/-home-ai-dev-claude-mem-lite/d888a8f3-388b-42a6-ab4e-4af6f5426d2c/scratchpad/d330/run1.jsonl at 2026-10-15T22:44:27.736Z
~~~~

`anthropic-only` 的 1 次 bad 是 `no-request`：fetch 包装器没有收到应答记录（查询 "queue"），属于传输
失败，不是模型的答案。as-shipped 组 72 次的 `finish_reason/native_finish_reason` 都是 `stop/end_turn`：
`native_finish_reason` 带的确实是 Anthropic 自己的 stop_reason。这和 65a09c6a 的假设（Anthropic 的拒答会以
`native_finish_reason: "refusal"` 出现）一致，但拒答本身没有观察到。

**这两句和上面的端点表，依据在哪里**（2026-10-16 补，发版前说法评审指出它们在仓库里没有存档）：
逐行文件 `run1.jsonl` 在那个会话的临时目录里，没有存档，已经清理掉了。以下原样摘自那个会话 transcript
（`~/.claude/projects/-home-ai-dev-claude-mem-lite/d888a8f3-388b-42a6-ab4e-4af6f5426d2c.jsonl`）里的工具输出：

- 22:48:11Z 读 `run1.jsonl` 的输出，统计的是 `as-shipped` 组全部行里 finish 取值的去重集合：

  ~~~~text
  no-request rows: anthropic-only:queue
  as-shipped finish: stop/end_turn
  req-params-no-temp sent: max_tokens,messages,model,provider,reasoning,response_format
  as-shipped sent: max_tokens,messages,model,reasoning,response_format,temperature
  ~~~~

- 端点表来自 `curl https://openrouter.ai/api/v1/models/anthropic/claude-haiku-5.5/endpoints` 的输出。
  那条命令每个端点打印一行：`provider_name | tag | status | $pricing.prompt（每 token 美元）| sp=supported_parameters`。原样如下：

  ~~~~text
  Google | google-vertex/global | 0 | $0.0000001 | sp=reasoning,include_reasoning,max_tokens,response_format,tool_choice,tools,verbosity,structured_outputs,stop,reasoning_effort
  Claude Platform on AWS | claude-on-aws | 0 | $0.0000001 | sp=reasoning,include_reasoning,max_tokens,stop,tool_choice,tools,response_format,verbosity,reasoning_effort
  Azure | azure/global | 0 | $0.0000001 | sp=reasoning,include_reasoning,structured_outputs,max_tokens,max_completion_tokens,tools,tool_choice,response_format,verbosity,stop,reasoning_effort
  Anthropic | anthropic | 0 | $0.0000001 | sp=reasoning,include_reasoning,max_tokens,stop,tools,tool_choice,structured_outputs,response_format,verbosity,reasoning_effort
  Amazon Bedrock | amazon-bedrock | 0 | $0.0000001 | sp=reasoning,include_reasoning,max_tokens,stop,tool_choice,tools,response_format,verbosity,reasoning_effort
  Google | google-vertex/europe | 0 | $0.00000011 | sp=reasoning,include_reasoning,max_tokens,response_format,tool_choice,tools,verbosity,structured_outputs,stop,reasoning_effort
  Google | google-vertex/us | 0 | $0.00000011 | sp=reasoning,include_reasoning,max_tokens,response_format,tool_choice,tools,verbosity,structured_outputs,stop,reasoning_effort
  Azure | azure/us | 0 | $0.00000011 | sp=reasoning,include_reasoning,structured_outputs,max_tokens,max_completion_tokens,tools,tool_choice,response_format,verbosity,stop,reasoning_effort
  Amazon Bedrock | amazon-bedrock/us-east-1 | 0 | $0.00000011 | sp=reasoning,include_reasoning,max_tokens,stop,tool_choice,tools,response_format,verbosity,reasoning_effort
  Amazon Bedrock | amazon-bedrock/eu-west-1 | 0 | $0.00000011 | sp=reasoning,include_reasoning,max_tokens,stop,tool_choice,tools,response_format,verbosity,reasoning_effort
  ~~~~

`req-params` 组 404 的 routing_funnel（原样）：

~~~~text
{"message":"No endpoints found that can handle the requested parameters. To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection","code":404,"metadata":{"routing_funnel":[{"step":"Initial Endpoints","endpoint_count":10},{"step":"Filter by Regional Surcharge","endpoint_count":5},{"step":"Filter by Allowed Providers","endpoint_count":1,"reason":"not in your account's allowed-providers setting"}],"failed_routing_step":"Filter by Parameters"}}
~~~~

改动之后（haiku-client 对 strict slug 不再发 `temperature`；工作树 = `c35b6f47` 加上这处未提交的改动），用同一探针的
`as-shipped` 组每条查询 1 次复测，2026-10-15T22:47Z：

~~~~text
{"arm":"as-shipped","n":24,"bad":0,"http":{"200":24},"providers":{"Anthropic":24},"badByProvider":{}}
sent keys: max_tokens,messages,model,reasoning,response_format
~~~~

## 探针脚本（原样）

~~~~js
// D#330 probe: does an OpenRouter provider without `structured_outputs` honour the rewrite's
// json_schema? Sends the SHIPPED body (built by haiku-client's callModelJSONAsync, captured
// through a fetch wrapper) plus one arm-specific `provider` field, through the shipped proxy helper.
import { readFileSync, writeFileSync } from 'node:fs';
const R = '/home/ai/dev/claude-mem-lite';
const OUT = process.argv[2];
const REPS = Number(process.argv[3] || 3);
const ARMS = (process.argv[4] || 'as-shipped,bedrock-only,anthropic-only,req-params,req-params-no-temp').split(',');
const { httpConnectProxyFor, postViaConnectProxy } = await import(R + '/lib/proxy-fetch.mjs');
const URL_ = 'https://openrouter.ai/api/v1/chat/completions';
const proxy = httpConnectProxyFor(URL_);
if (!proxy) { console.error('no proxy resolved; refusing (this machine needs one)'); process.exit(2); }
for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete process.env[k];
if (httpConnectProxyFor(URL_)) { console.error('proxy still resolves; the wrapper would be bypassed'); process.exit(2); }
if (process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY set; the direct leg would run'); process.exit(2); }
if (!process.env.OPENROUTER_API_KEY) { console.error('no OPENROUTER_API_KEY'); process.exit(2); }
process.env.CLAUDE_CODE_PATH = R + '/benchmark/.no-such-claude-cli';
delete process.env.OPENROUTER_MODEL;

const ARM_PROVIDER = {
  'as-shipped': null,
  'bedrock-only': { only: ['amazon-bedrock'], allow_fallbacks: false },
  'aws-platform-only': { only: ['claude-on-aws'], allow_fallbacks: false },
  'anthropic-only': { only: ['anthropic'], allow_fallbacks: false },
  'req-params': { require_parameters: true },
  'req-params-no-temp': { require_parameters: true },
};
let arm = null;
let last = null;
globalThis.fetch = async (url, init) => {
  if (String(url) !== URL_) throw new Error('unexpected url ' + url);
  const body = JSON.parse(init.body);
  if (ARM_PROVIDER[arm]) body.provider = ARM_PROVIDER[arm];
  if (arm === 'req-params-no-temp') delete body.temperature;
  const res = await postViaConnectProxy(proxy, URL_, { headers: init.headers, body: JSON.stringify(body), timeout: 60000 });
  const txt = res.text();
  let j = null;
  try { j = JSON.parse(txt); } catch {}
  last = {
    sentKeys: Object.keys(body).sort().join(','),
    status: res.status,
    provider: j?.provider ?? null,
    finish: j?.choices?.[0]?.finish_reason ?? null,
    native: j?.choices?.[0]?.native_finish_reason ?? null,
    content: j?.choices?.[0]?.message?.content ?? null,
    err: j?.error ? JSON.stringify(j.error).slice(0, 3000) : null,
  };
  return { ok: res.ok, status: res.status, headers: res.headers, text: async () => txt, json: async () => JSON.parse(txt) };
};

const { callModelJSONAsync, _resetMode } = await import(R + '/haiku-client.mjs');
const { buildRewritePrompt, assembleVariants, REWRITE_JSON_SCHEMA } = await import(R + '/deep-search.mjs');
const { pickEvenly } = await import(R + '/benchmark/haiku-model-ab.mjs');
const rq = (f) => JSON.parse(readFileSync(`${R}/benchmark/fixtures/${f}`, 'utf8')).queries.map((q) => q.query);
const qs = pickEvenly([...rq('test-queries.json'), ...rq('test-queries-vocab-mismatch.json'), ...rq('test-queries-cjk.json')], 24);
_resetMode?.();

const rows = [];
for (const a of ARMS) {
  arm = a;
  const summary = { arm: a, n: 0, bad: 0, http: {}, providers: {}, badByProvider: {} };
  for (const q of qs) for (let i = 0; i < REPS; i++) {
    last = null;
    let parsed = null;
    try { parsed = await callModelJSONAsync(buildRewritePrompt(q), 'haiku', { timeout: 30000, maxTokens: 400, jsonSchema: REWRITE_JSON_SCHEMA }); } catch {}
    const ok = assembleVariants(q, parsed).length >= 2;
    const r = { arm: a, q, rep: i, ok, ...(last || { status: 'no-request' }) };
    rows.push(r);
    summary.n++; if (!ok) summary.bad++;
    summary.http[r.status] = (summary.http[r.status] || 0) + 1;
    const p = r.provider || '(none)';
    summary.providers[p] = (summary.providers[p] || 0) + 1;
    if (!ok) summary.badByProvider[p] = (summary.badByProvider[p] || 0) + 1;
  }
  console.log(JSON.stringify(summary));
  if (rows.at(-1)?.err) console.log('  last err:', rows.at(-1).err);
}
writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log('rows ->', OUT, 'at', new Date().toISOString());
~~~~

运行：`node probe.mjs <out.jsonl> 3 as-shipped,bedrock-only,aws-platform-only,anthropic-only,req-params,req-params-no-temp`。
