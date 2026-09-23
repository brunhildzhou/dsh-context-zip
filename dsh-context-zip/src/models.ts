/**
 * 已注册模型清单，以及保存设置时那一次最小探活。
 *
 * 面板要能选模型，而「哪些模型能用」这个问题只有 `ctx.llm` 知道，所以清单必须从
 * 活的注册表现读，不能在插件里写死一份。探活是另一件事：注册表说某个路由存在，
 * 不等于这次真能打通（凭据过期、端点不通、模型名被 provider 下线都会让清单独有
 * 其表），所以保存设置时真的发一次最小请求。
 *
 * 三件事分得很清，因为它们的失败含义不同：
 *
 * - `listProviders()` / `listModels()` —— **注册情况**。清单是**建议性**的：
 *   接口自己写着「adapter 可以接受未列出的 model id，consumer 不得把不在清单里
 *   当成拒绝请求的理由」，所以清单只用来渲染下拉框与给出提示，不用来当门。
 * - `resolveModelInfo()` —— **可用性**。它由拥有该路由的 adapter 回答，未知 provider
 *   抛 `NO_ADAPTER`，元数据非法抛 `INVALID_MODEL_*`。保存时要过这一关。
 * - 一次最小 `stream()` —— **探活**。这一关过了才叫「探得通」。
 *
 * @module dsh-context-zip/models
 */

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { LlmFailure } from '@deepseek-ai/dsh-llm';

import { PRODUCER_KIND } from './producer.ts';

/**
 * 探活请求的输出上限，单位 token。
 *
 * 8 是实测选出来的：给 1 会让某些 provider 在只输出一个 token 后以 `max-tokens`
 * 收尾（仍然算探通，但日志难读），而探活要的只是「一个来回」。输入侧是十几个
 * token 的系统提示加一个 `ok`，所以一次探活的实际花费在几十 token 量级。
 */
export const PROBE_MAX_TOKENS = 8;

/** 探活请求的系统提示。要求极短回复，把输出压在上限之内。 */
export const PROBE_SYSTEM_INSTRUCTION = 'Reply with the single word: ok';

/** 探活请求的用户消息。内容是无关紧要的，这一趟只验通路。 */
export const PROBE_USER_TEXT = 'ok';

/** 探活请求的默认超时，单位毫秒。 */
export const PROBE_TIMEOUT_MS = 30_000;

/**
 * 探活请求携带的会话号。
 *
 * **这不是装饰**。有些 provider 需要 harness 附一个路由头才会应答，而那个头是从
 * `GenerateOptions.sessionId` 推出来的（本机是 `dsh-opencode-session`，`mode:
 * session-id`，头名 `x-opencode-session`）；不带 `sessionId` 时它直接放行不加头，
 * 于是请求到了上游被判成不可路由。实测：带这个常量探活正常，不带则
 * `finished as error: Request timed out.`（同样的路由、同样的模型）。
 *
 * 用一个固定的合成值是有意的：探活与任何会话无关，它只需要一个稳定的路由桶。
 * 前缀写得可辨认，好让上游日志里一眼看出这不是一次真实会话。
 */
export const PROBE_SESSION_ID = 'context-zip-rewrite-probe';

/**
 * 逐个 provider 读一遍它当前广告的模型。
 *
 * provider 级别的失败被隔离成 `failures` 条目而不是让整份清单塌掉，做法照抄
 * harness 自己的 `buildModelCatalog`：一个 provider 的 adapter 抛错不该让面板
 * 连别的 provider 都看不见。
 *
 * @param llm - `ctx.llm`，只要带 `listProviders` 与 `listModels` 即可（测试传假的）。
 * @returns `{ providers, failures }`，两者都按注册顺序。
 */
export async function readModelCatalog(llm) {
  const providers = typeof llm?.listProviders === 'function' ? llm.listProviders() : [];
  const groups = [];
  const failures = [];
  for (const provider of providers ?? []) {
    const id = String(provider?.id ?? '');
    if (id.length === 0) continue;
    const name = typeof provider?.name === 'string' && provider.name.length > 0 ? provider.name : id;
    try {
      const models = await llm.listModels(id);
      groups.push({
        id,
        name,
        models: (models ?? [])
          .map((model) => ({ id: String(model?.id ?? ''), name: String(model?.name ?? model?.id ?? '') }))
          .filter((model) => model.id.length > 0),
      });
    } catch (error) {
      failures.push({ id, name, message: String(error?.message ?? error) });
    }
  }
  return { providers: groups, failures };
}

/**
 * 判断一个 provider 是否已注册，未注册时给出可用清单。
 *
 * @param llm - `ctx.llm`。
 * @param provider - 要检查的 provider 路由。
 * @throws 当该 provider 不在注册表里。
 */
export function requireRegisteredProvider(llm, provider) {
  const providers = typeof llm?.listProviders === 'function' ? llm.listProviders() : [];
  const ids = (providers ?? []).map((entry) => String(entry?.id ?? '')).filter((id) => id.length > 0);
  if (ids.includes(provider)) return;
  throw new Error(
    `LLM provider "${provider}" is not registered; registered providers: ${ids.join(', ') || '(none)'}`,
  );
}

/**
 * 发一次最小请求，验这条 provider/model 路由此刻真的通。
 *
 * 判据是**终结原因不是失败**，不是「回复内容对不对」：探活问的是通路，不是能力。
 * `stop`、`max-tokens`、`tool-calls` 都表示 provider 答了一个来回；`error` 与
 * `aborted` 才是不通，前者把 provider 的原话带出去，后者说明是超时或调用方取消。
 *
 * @param llm - `ctx.llm`。
 * @param provider - 已注册的 provider 路由。
 * @param model - 要探活的 model id。
 * @param options - 可选的取消信号与输出上限。
 * @returns `{ finish, usage }`，`finish` 是终结原因的种类。
 * @throws 当 provider 未注册、元数据取不到，或这一趟以失败收尾。
 */
export async function probeModel(llm, provider, model, options: { signal?: AbortSignal; maxTokens?: number } = {}) {
  requireRegisteredProvider(llm, provider);
  // 注册过了不代表能解析：adapter 可能同名却没接上凭据，或模型元数据非法。
  await llm.resolveModelInfo(provider, model, options.signal);
  const maxTokens = Number.isSafeInteger(options.maxTokens) && options.maxTokens > 0 ? options.maxTokens : PROBE_MAX_TOKENS;
  const assembler = new BlockAssembler();
  const request = {
    provider,
    model,
    // 见 PROBE_SESSION_ID：没有它，需要路由头的 provider 会拒答或超时。
    sessionId: PROBE_SESSION_ID,
    messages: [
      createUserMessage({
        content: [{ type: 'text', text: PROBE_USER_TEXT }],
        // `ContextForm` 是闭集：instructions / catalog / snapshot / notice / relay /
        // recall，没有「探活」这一档。该类型自己的文档写明「不声明的上下文就是文档化
        // 的默认档，按不透明内容呈现」，而这条消息只发不落盘、插件侧也从不回读 form，
        // 所以在这里不声明 form，而不是自造一个词表外的值。
        source: { kind: PRODUCER_KIND, plugin: 'context-zip' },
      }),
    ],
    system: PROBE_SYSTEM_INSTRUCTION,
    maxTokens,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  for await (const chunk of llm.stream(request)) assembler.push(chunk);
  const finish = assembler.finish;
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    // 与 engine 侧同一处形状：`{}` 是适配器违约时的兜底，标注成 Partial 才不会让
    // 它的空对象类型把 message/status 抹掉。
    const failure: Partial<LlmFailure> = finish.failure ?? {};
    throw new Error(
      `the probe call to ${provider}/${model} finished as ${finish.kind}${
        failure.message === undefined ? '' : `: ${failure.message}`
      }${failure.status === undefined ? '' : ` (HTTP ${failure.status})`}`,
    );
  }
  return { finish: finish.kind, usage: assembler.usage };
}

export default { PROBE_MAX_TOKENS, PROBE_SYSTEM_INSTRUCTION, PROBE_USER_TEXT, PROBE_TIMEOUT_MS, PROBE_SESSION_ID, readModelCatalog, requireRegisteredProvider, probeModel };
