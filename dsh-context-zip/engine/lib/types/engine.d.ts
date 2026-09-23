/**
 * The compaction backend.
 *
 * {@link ContextZipEngine} subclasses the shipped basic backend and overrides its
 * sole documented customization hook, `summarize()`. Everything that makes
 * compaction safe — the 80% pressure policy, the retained tail, the durable lock
 * bracket, retry, overflow recovery, and the surface replacement itself — is
 * inherited unchanged.
 *
 * What this subclass changes:
 *
 * - the summarizer instruction becomes the five-section handoff template;
 * - the live notes draft is appended as explicitly labeled intent material;
 * - the generation cap is pinned to the documented hard cap.
 *
 * All three apply only to sessions the plugin half reports as being in plugin
 * mode. A session in default mode is handed back to `super.summarize()`, which
 * reproduces the shipped behavior exactly, including the shipped 8192-token cap.
 *
 * The summarization call itself is written here against the public
 * `ctx.llm.stream()` and `BlockAssembler` API rather than reusing the backend's
 * internal helper: that helper is not part of the package's public exports, and
 * a plugin may not reach into another package's private module graph. The shape
 * of the call is identical, including the prefix reuse that keeps the provider's
 * prompt cache warm.
 *
 * @module dsh-context-zip-engine
 */
export declare function classifySummary(text: any): {
    accept: boolean;
    sections: number;
    reason: string;
    detail: string;
};
/**
 * Concrete tokens a summary asserts that its source never contained.
 *
 * The shape gate above answers "is this a handoff summary". It cannot answer "is it
 * TRUE", and the failure that motivated this check is the second kind: a summary that
 * reads perfectly and states a rule nobody wrote down. Measured cost of that class —
 * the recursion cell answered both questions with a decision the material never made,
 * and 16.1% of A2 compactions failed outright.
 *
 * The check is deliberately narrow. It looks only for tokens that are CHEAP TO VERIFY
 * and expensive to get wrong: identifiers, paths, constants and large numbers. A token
 * that appears nowhere in the source is not proof of a hallucination — it can be a
 * paraphrase, a derived value, or a word the summarizer coined for a concept — which is
 * exactly why this is a WARNING and not a gate. What it does give is a short list a
 * human or a later pass can check, and a count that can be compared across arms.
 *
 * @param summaryText - the summarizer's joined output.
 * @param sourceText - the text it was asked to replace.
 * @param options - `scope` as before; `normalizePaths` (待办 17, default ON) folds the
 *   spelling variants the source itself mixes; `fileExists` (待办 16 判据 1) is consulted
 *   only when nothing else explains the token, and is **not wired by default**.
 * @returns the tokens not found in the source, longest first, capped.
 */
export declare function findUnsupportedClaims(summaryText: any, sourceText: any, options?: UnsupportedClaimOptions): string[];
/** 判据 1 的判定结果。`unknown` 是「判不了」，不是「不存在」。 */
export type FileExistenceVerdict = 'exists' | 'absent' | 'unknown';
/**
 * 判据 1：一个路径 token 指向的文件在不在工作区里。
 *
 * **为什么它是一个注入的判定器而不是内部去读文件系统**：引擎跑在压缩调用里，压缩
 * 是旁路操作，不该在热路径上做磁盘遍历；而且真机上「工作区」的权威清单有多个来源
 * （真目录扫描、工具回执带回的文件列表、会话里出现过的树清单），由调用方决定用哪
 * 一个。所以这里只定义一个回答「在 / 不在 / 判不了」的函数。
 */
export type FileExistenceOracle = (token: string) => FileExistenceVerdict;
/** B10 的判据选项。 */
export type UnsupportedClaimOptions = {
    scope?: 'paths' | 'all';
    normalizePaths?: boolean;
    fileExists?: FileExistenceOracle | null;
};
/** 一条逐 token 的判定记录。 */
export type UnsupportedClaimAudit = {
    token: string;
    /** `present` 原文里有；`spelling` 归一化后原文里有；`missing` 两边都没有。 */
    source: 'present' | 'spelling' | 'missing';
    /** `source === 'spelling'` 时，原文里那种写法的形式。 */
    spelling?: string;
    /** 判据 1 的结论；没接判定器、或该 token 不是路径时恒为 `unknown`。 */
    existence: FileExistenceVerdict;
    /** 最终算不算「原文里没有的编造候选」。 */
    unsupported: boolean;
};
/**
 * 一份文本里的路径形 token（{@link candidateTokens} 的子集，B10 路径档的同一个集合）。
 *
 * @param text - 任意文本。
 * @returns 路径形 token，按出现顺序。
 */
export declare function pathTokensIn(text: any): string[];
export declare function auditUnsupportedClaims(summaryText: any, sourceText: any, options?: UnsupportedClaimOptions): UnsupportedClaimAudit[];
/**
 * 用一份「真实存在的文件清单」造一个判据 1 判定器。
 *
 * **清单从哪来由调用方决定**，这正是真机与语料的差别所在：语料里没有真实代码树，
 * 所以判据 1 在那里没有对象；真机的原文里带着工具回执，会话日志里也有整棵树的
 * 清单，那些都能拼出这份清单。
 *
 * 判定与 B10 的路径写法归一化同一套：`./`、前导 `/`、分隔符折叠、大小写都不影响。
 * **只有整条路径对得上才回 `exists`**；只对上文件名（换目录）回 `unknown`——那正是
 * 真编造里「真实文件换了目录」那一类，回 `exists` 会把它救掉。
 *
 * @param paths - 已知真实存在的文件路径，任意写法。
 * @returns 判据 1 判定器。
 */
export declare function fileOracleFromList(paths: Iterable<string>): FileExistenceOracle;
/**
 * 两个路径 token 是不是「同一个文件的两种写法」。
 *
 * 判据与 判据 2 的规则 1 同一套：按段比较（小写、折叠 `.`/`_`/`-`、去掉 `./`、`../`、
 * 前导 `/`），一方的段序列是另一方的后缀就是同一个文件。`diag/ledger.rs` 对
 * `src/diag/ledger.rs`、对 `./diag/ledger.rs` 都成立，`ci/secret-audit.sh` 对
 * `ci/secrets-audit.sh`（文件名不同）不成立。
 *
 * **段序列相同一律算**；只做后缀比较时，**短的那一方必须有目录段**（≥2 段）。
 * 没有这一条，`zzzcache/watermark.rs` 会因为名字在原文里裸着出现过而与 `watermark.rs`
 * 认成同一个文件——那正是待办 17 实测出来的两个洞之一。护栏只在 `before`（B10 报出来的
 * 标记，全部带 `/`）上比，所以这条限制不损失任何真的换写法。
 *
 * @param left - 一个路径 token。
 * @param right - 另一个路径 token。
 * @returns 同一个文件时为 true。
 */
export declare function sameFileSpelling(left: any, right: any): boolean;
/**
 * 丁：改写护栏的判决——`added` 里该退掉这次改写的那几条。
 *
 * **与甲的区别**：甲是「新增集合差非空就退」，不问新增的是什么；丁把每一条新增拿去问
 * 判据 1（{@link FileExistenceOracle}），只在**判据 1 没有正面证据说这个文件存在**、
 * **而且它也不是改写前就被标出的那个文件的另一种写法**时才退。
 * 前者放行真机上「文件真的在」的 token，后者放行 W1/W2 残留的那 17 条
 * （`diag/ledger.rs` → `src/diag/ledger.rs` 这类：集合差按字符串比，换写法会被读成新增）。
 *
 * **判据 1 不接（`oracle` 为 `null`）时不退任何东西**：那是「这次压缩取不到清单」的
 * 降级，方向是安全侧（没有证据就不动用户已经拿到的摘要）。代价写在同一份报告里：
 * 这一档下新增的编造一条也拦不住。
 *
 * @param added - `after ∖ before` 的 token（{@link addedClaims}）。
 * @param flagged - 改写**前**就报出来的 token（甲口径的 `before`，不掺判据 1 的救援）。
 * @param oracle - 判据 1 的判定器，或 `null`（不接）。
 * @returns 该退掉的 token；空数组表示放行。
 */
/**
 * 丁：改写护栏的判决——该退掉这次改写的那几条路径 token。
 *
 * **与甲的区别**：甲是「`after ∖ before` 非空就退」，两个集合都是 B10 的**上报清单**，
 * 于是它有两个问题：一是「同一文件换写法」在字符串差里成了新成员（W1/W2 残留的 17 条），
 * 二是判据 2 的宽松规则（裸名补目录、同目录一字之差）先把 token 救走了，判据 1 根本没
 * 机会说话（待办 17 实测的两个洞）。丁换成一条判据：
 *
 * **改写里出现了一条改写前没有的路径，而判据 1 又不能证明这个文件存在 → 退。**
 *
 * 「改写前没有」按两步算（{@link introducedPaths}）：逐字出现过就算有；没逐字出现过，
 * 但按 {@link sameFileSpelling} 是同一个文件的另一种写法（`diag/ledger.rs` 对
 * `src/diag/ledger.rs`、对 `./diag/ledger.rs`）也算有。
 *
 * 「证明这个文件存在」只有一档：判据 1 回 `exists`。回 `unknown`（只对上文件名、目录对
 * 不上）与 `absent` 都算证不出来——那正是「真实文件换目录」「同目录一字之差」「裸名 +
 * 编造目录」三种形状。
 *
 * **判据 1 不接（`oracle` 为 `null`）时不退任何东西**：那是「这次压缩取不到清单」的降级，
 * 方向是安全侧（没有证据就不动用户已经拿到的摘要）。代价写在报告里：这一档下新增的
 * 编造一条也拦不住。
 *
 * @param rewrittenText - 改写后的摘要。
 * @param originalText - 改写前的摘要（身份对照集从这里来）。
 * @param oracle - 判据 1 的判定器，或 `null`（不接）。
 * @returns 该退掉的 token；空数组表示放行。
 */
/**
 * 改写相对原摘要**新引入**的路径 token（丁口径的「新增」）。
 *
 * 两步都过不了才算新引入：
 * 1. **逐字**：这条 token 在改写前的摘要里出现过；
 * 2. **身份**：它是改写前某个路径 token 的另一种写法（{@link sameFileSpelling}）。
 *
 * 第 2 步是 W1/W2 那 17 条的出口：集合差按字符串比时，`diag/ledger.rs` 加一个 `src/`
 * 或 `./` 就成了「新成员」，而它并不是改写新引入的文件。
 *
 * @param rewrittenText - 改写后的摘要。
 * @param originalText - 改写前的摘要。
 * @returns 新引入的 token，按在改写里出现的顺序。
 */
export declare function introducedPaths(rewrittenText: any, originalText: any): string[];
export declare function rewriteGuardBlocks(rewrittenText: any, originalText: any, oracle: FileExistenceOracle | null): string[];
/**
 * 一份「这次压缩能看到的文件清单」，判据 1 的输入。
 *
 * 三个数分开报，是因为它们的差别就是「清单从哪来」的答案：`receipts` 是工具回执带回来
 * 的真实文件列表，`session` 是会话正文里出现过的路径写法（回执正文也算正文，所以
 * `session` 不小于 `receipts`）。
 */
export type CompactionFileList = {
    /** 判据 1 的判定器；清单为空时是 `null`，表示这次压缩取不到清单。 */
    oracle: FileExistenceOracle | null;
    /** 清单条目（去重后的路径写法，裸文件名也收）。 */
    paths: string[];
    /** 其中来自工具回执的条数。 */
    receipts: number;
    /**
     * 清单的来源。`receipts` 工具回执里有；`session` 只有会话正文；`none` 取不到清单；
     * `deps` 用的是嵌入方给的判定器（`deps.fileExists`）；`off` 是嵌入方明确关掉判据 1。
     */
    source: 'deps' | 'receipts' | 'session' | 'none' | 'off';
};
/**
 * 从这次压缩的原文事件里抽一份文件清单，造判据 1 的判定器（丁的清单来源）。
 *
 * **为什么从这里抽、不扫工作区**：改写发生在压缩调用里，压缩是旁路操作，不该在热路径
 * 上遍历磁盘；而且判据 1 在护栏这一支要回答的是「**这次压缩**里有没有证据说这个文件
 * 存在」，证据就在被压缩的那段原文里。工具回执带回的文件列表是其中最硬的一份
 * （`ls`、`rg --files`、读文件回执都会带出真实文件名），会话正文里出现过的路径是它的
 * 兜底：语料里的原文是散文、没有回执，清单只能从正文来。
 *
 * @param messages - 本次压缩的输入消息。
 * @returns 清单与判定器；清单为空时 `oracle` 是 `null`（判据 1 不接）。
 */
export declare function fileListFromMessages(messages: any): CompactionFileList;
/**
 * 一条消息里**模型真正看得见**的全部文本，B10 的原文投影。
 *
 * **为什么 B10 不能继续用 {@link messageContentText}**：那个投影只读 `block.text`，而
 * 真机的三样材料里有两样的正文不在这个字段上——
 *
 * 1. **工具回执**：形状是
 *    `{source:{kind:'tool'}, role:'user', content:[{type:'tool-result', toolCallId, content:[{type:'text', text:'…'}]}]}`，
 *    正文在嵌套的 `content` 里，`block.text` 是 undefined，窄投影对整条消息返回空串；
 * 2. **工具调用**：形状是 `{type:'tool-call', name, arguments}`，`arguments` 是模型自己
 *    写出来的那段 JSON 文本（实测全库 27,524/27,524 都是非空字符串），窄投影也不读它。
 *
 * 实测代价（真机 31 次压缩上窄投影的原文中位
 * 304,281 字符，而模型实际看到 643,287 字符；A 臂 49 个「原文里没有」的标记里 42 个的
 * 路径就明明白白出现在工具回执或 `arguments` 里。原文缺了一半，判据就把模型真读过的
 * 东西当成编造。
 *
 * **共用函数不动**：`messageContentText` 还有别的调用方（分节归属、机械摘要），它们的
 * 口径是另外两件事，改它等于顺手改掉两处与本条无关的行为。所以这里另立一条更全的投影，
 * 只有 B10 的两个原文位用它：`runSummarizationCall` 的查原文、以及改写护栏之后那次回查。
 *
 * 只读字符串字段（`text`、`arguments`），不把对象序列化进来：真机上这两样都是字符串，
 * 序列化别的对象（例如图片的 `attachment`）会往原文里塞进模型没读过的字节。
 *
 * @param message - 一条消息，或它下面的任意一层。
 * @returns 它携带的全部文本，'\n' 连接；没有可读文本时是 ''。
 */
export declare function messageVisibleText(message: any): string;
/**
 * Which part of the replaced text each summary section came from.
 *
 * The acceptance criterion for this is "every summary line can be traced back to a range
 * of the original". The obvious way to get that is to make the summarizer emit the ranges,
 * and that way is closed: the five-section template already costs 16.1% of compactions
 * outright, and every additional required field is another way for the response to miss
 * the shape gate. So the attribution is DERIVED instead of asserted — the summary is never
 * asked to describe itself.
 *
 * The method is overlap on distinctive tokens, which is enough for the question this
 * answers: given a summary line, which part of the source should a reader open to check
 * it. It is not a claim about which sentence caused which words.
 *
 * @param summaryText - the summarizer's joined output.
 * @param messages - the summarization input, in source order.
 * @returns one entry per section, with the message range it best matches.
 */
export declare function attributeSummarySections(summaryText: any, messages: any): {
    heading: any;
    from: number;
    to: number;
    score: number;
    shared: number;
    traceable: boolean;
}[];
/** Plugin identity used for synthesized messages. */
export declare const PLUGIN_ID = "context-zip";
/**
 * The producer-owned message-source kind these messages carry.
 *
 * 0.1.7-alpha.1 deleted the shared catch-all `plugin` kind and refuses that
 * retired literal at the session-format boundary, so a message carrying it
 * fails the whole turn instead of landing. The harness's own V3 migration
 * rewrites released `{ kind: 'plugin', plugin: X }` rows to `plugin:X`, which is
 * why this spelling also matches the rows already on disk. `source.plugin`
 * stays beside it: the mechanical summary below filters by that field.
 */
export declare const PRODUCER_KIND = "plugin:context-zip";
/**
 * Build the final user message of a summarization call.
 *
 * @param notes - the live notes draft, or '' when the session has none.
 * @returns one frozen user message carrying the instruction.
 */
export declare function buildSummarizationInstruction(notes: any): {
    readonly content: readonly import("@deepseek-ai/dsh-llm").ContentBlock[];
    readonly source: import("@deepseek-ai/dsh-llm").MessageSource;
} & Pick<import("@deepseek-ai/dsh-llm").UserMessage, "id" | "role">;
/**
 * Resolve the provider/model one summarization call should use.
 *
 * Precedence matches the shipped backend: an explicit configured pair wins, then
 * the conversation's latest durable routed request, then the agent's own options.
 *
 * @param config - resolved backend configuration.
 * @param agent - the agent being compacted.
 * @returns the target route, or undefined when none is resolvable.
 */
export declare function summarizeTarget(config: any, agent: any): {
    provider: any;
    model: any;
};
/**
 * Run one cache-reusing summarization call and reduce it to text.
 *
 * @param ctx - context providing the LLM service.
 * @param config - resolved backend configuration.
 * @param input - replayed conversation prefix to condense.
 * @param agent - supplies routing history, fallback target, and session id.
 * @param signal - optional cancellation forwarded to the adapter.
 * @param claims - B10 的判据选项，从引擎的 `deps` 透传进来；缺省即两样都不接。
 * @returns text-only summary blocks plus the exact call envelope.
 */
export declare function runSummarizationCall(ctx: any, config: any, input: any, agent: any, signal: any, claims?: UnsupportedClaimOptions): Promise<{
    usage?: import("@deepseek-ai/dsh-llm").TokenUsage;
    summary: import("@deepseek-ai/dsh-llm").TextBlock[];
    rawOutput: import("@deepseek-ai/dsh-llm").ContentBlock[];
    unsupportedClaims: string[];
    sectionSources: {
        heading: any;
        from: number;
        to: number;
        score: number;
        shared: number;
        traceable: boolean;
    }[];
    llmStreamCall: boolean;
    provider: any;
    model: any;
    maxTokens: any;
}>;
/**
 * 一个模型能用的最低思考档位。
 *
 * 用户拍板：改写是机械任务，思考深度锁最低档，界面不暴露旋钮。理由有两条，都在
 * 用户原话里：推理模型倾向「顺便把内容改好」，档位越高越容易越界；暴露旋钮等于
 * 邀请用户调高。所以这里没有「让用户选」的分支。
 *
 * `reasoning` 为 undefined 表示该模型根本没有思考档位可调（不是「不知道」）——
 * 此时不传 `reasoningEffort`，因为传了会被 `LlmRuntime` 以
 * `UNSUPPORTED_REASONING_EFFORT` 拒掉。
 *
 * @param reasoning - `LlmResolvedModelInfo.reasoning`，或 undefined。
 * @returns 要传给 `GenerateOptions.reasoningEffort` 的值，或 undefined 表示不传。
 */
export declare function lowestReasoningEffort(reasoning: any): any;
/**
 * 改写相对原文**新增**的编造 token = 两个集合的差。
 *
 * **为什么是集合差而不是数量差**：数量差会把「退掉一个、新增一个」读成没变。护栏要
 * 回答的是「这份改写往上下文里塞了原文没有、原摘要也没有的东西吗」，那是一个关于
 * 成员的问题，不是关于多少的问题。
 *
 * **比较是字面的**，不做分隔符归一。`findUnsupportedClaims` 内部查原文时会把
 * `.`/`_`/`-` 折叠成一个字符，那是它自己的判据；护栏这一层不再叠一层归一，因为
 * 那等于替用户放宽他拍板的判据。代价是实测出来的：见
 * `docs/功能文档.md` §九 的误退率。
 *
 * @param before - 原摘要跑 B10 的结果。
 * @param after - 改写跑 B10 的结果。
 * @returns `after` 里有、`before` 里没有的 token，保持 `after` 的顺序。
 */
export declare function addedClaims(before: any, after: any): any[];
/**
 * 从改写设置的读取器返回值里算出一次改写要用的路由，或算出为什么不能用。
 *
 * 三种「不能用」都退回原散文，不抛错：开关没开、provider/model 没选全。
 *
 * @param value - reader 的返回值 `{ enabled, provider, model }`。
 * @returns `{ route }` 或 `{ reason }`。
 */
export declare function resolveRewriteRoute(value: any): {
    reason: string;
    route?: undefined;
} | {
    route: {
        provider: any;
        model: any;
    };
    reason?: undefined;
};
/**
 * 跑一次只改格式的改写调用。
 *
 * **输入只有那份摘要。** 被压缩的对话不重发：一是贵（那是整段对话再发一遍），二是
 * 改写本来就不该看见新素材——它看不见，就没有东西可以编。护栏仍然要跑，因为「看不见」
 * 是提示词层面的事实，不是接口层面的保证。
 *
 * **思考档位锁最低。** 见 {@link lowestReasoningEffort}。
 *
 * @param ctx - context providing the LLM service.
 * @param config - resolved backend configuration; `maxTokens` is reused as the cap.
 * @param summaryText - the summary to re-lay-out; the only model-visible input.
 * @param route - `{ provider, model, reasoningEffort? }`.
 * @param sessionId - owning session id, stamped for routing like the summary call.
 * @param signal - optional cancellation forwarded to the adapter.
 * @returns the rewritten text.
 */
export declare function runRewriteCall(ctx: any, config: any, summaryText: any, route: any, sessionId: any, signal: any): Promise<string>;
/**
 * 注册「格式改写」档位的读取器，由 `src/index.ts` 在设置变化时注入。
 *
 * @param reader - `() => { enabled, provider, model }`，或 null 清除。
 * @returns 注销函数，恢复注册前的读取器。
 */
export declare function setSharedRewriteReader(reader: any): () => void;
/**
 * Register the fallback reader used when an engine carries none of its own.
 *
 * @param reader - `(sessionId) => Promise<string>`, or null to clear.
 * @returns the disposer that restores the previous registration.
 */
export declare function setSharedNotesReader(reader: any): () => void;
/**
 * 注册兜底开关的读取器。
 *
 * @param reader - `() => { enabled, after }`，或 null 清除。
 * @returns 注销函数，恢复注册前的读取器。
 */
export declare function setSharedFallbackReader(reader: any): () => void;
/** 只在测试里用：清掉计数。 */
export declare function resetFailureStreaks(): void;
/**
 * 读一个会话的连续失败次数。
 *
 * 手动压缩的报错文案要带出「已经失败了几次」，否则用户只看到「压缩失败」，
 * 分不清该重试还是该等兜底。计数只在**本插件自己压的会话**上累加：交回内置
 * 后端的会话永远读到 0，调用方要能说出这一点（见 `manualFailureText`）。
 *
 * @param sessionId - 要读的会话号。
 * @returns 连续失败次数，从未失败过是 0。
 */
export declare function failureCount(sessionId: any): any;
/**
 * 登记一个能执行手动压缩的引擎实例。
 *
 * @param seat - `(agent, signal, commandId) => Promise<CompactionResult|null>`。
 * @returns 注销函数。
 */
export declare function addManualCompactionSeat(seat: any): () => void;
/** 当前有没有可用的手动压缩座位。 */
export declare function hasManualCompactionSeat(): boolean;
/**
 * 走登记好的引擎实例执行一次手动压缩。
 *
 * @param agent - 要压缩的活会话所属 agent。
 * @param signal - 取消信号。
 * @param commandId - 发起这次压缩的命令身份，可选。
 * @returns 压缩结果，或没有可压区间时的 null。
 * @throws 没有任何实例登记时抛错：这条信息比「压缩失败」有用，它说明插件没被装进
 *   任何 agent 预设 realm。
 */
export declare function runManualCompaction(agent: any, signal: any, commandId: any): Promise<any>;
/** 只在测试里用：清掉登记的座位。 */
export declare function resetManualCompactionSeats(): void;
/**
 * 机械摘要：不加任何模型调用，从会话事件拼一份流水账。
 *
 * **为什么需要它**：模型反复写不出可用摘要时，压缩就一直压不成，窗口只涨不缩。
 * 这份摘要**永不失败、不可能编造**（每一行都来自事件本身），代价是没有模型摘要的
 * 判断力，读起来像台账。
 *
 * **为什么不用「接受任何非空摘要」兜底**：一份质量极差的模型摘要进了上下文**看不出
 * 它差**，这与本项目反复出现的那类毛病同类；机械摘要一眼能认出是兜底产物。
 *
 * **插件自己拼的消息不算事件**：摘要指令那条带着 `source.plugin === PLUGIN_ID`，而调用方交给
 * 这里的是「发给模型的那份消息数组」，末尾正挂着它。把它数进去会让两个数字同时虚高
 * （实测 1 条真事件加 1 条指令 → 正文写「2 event(s)」「user 2」，字数从 7 涨到 4398）。
 * 这条摘要存在的理由就是「不可能编造」，里面唯一的两个数字必须对，所以按 `source.plugin`
 * 过滤，不指望调用方记得换一个参数。
 *
 * @param messages - 即将被压缩掉的对话。
 */
export declare function buildMechanicalSummary(messages: any): string;
/**
 * Register the reader that answers which summarizer one session uses.
 *
 * The engine and the plugin are separate packages, so this module-level hook is
 * how the per-session decision crosses the boundary — the same mechanism as
 * {@link setSharedNotesReader}. A missing reader degrades to `'plugin'`, which
 * is this package's own behavior and the reason it exists.
 *
 * @param reader - `(session) => Promise<'plugin'|'default'>|'plugin'|'default'`, or null to clear.
 *   Receives the session itself so a reader can consult its header, not only its id.
 * @returns the disposer that restores the previous registration.
 */
export declare function setSharedModeReader(reader: any): () => void;
/**
 * Build the compaction engine class over a supplied base.
 *
 * The base is passed in rather than imported because this plugin's profile
 * redirects the `@deepseek-ai/dsh-compaction-basic` specifier to itself: an
 * import of that specifier from here would resolve back to this plugin. The
 * redirect package, which sits outside the redirect, is the one place that may
 * name it.
 *
 * @param Base - the shipped `BasicCompactionEngine` class.
 * @returns a subclass that overrides only the documented `summarize()` hook.
 */
export declare function createContextZipEngine(Base: any): {
    new (ctx: any, config: any, deps: any): {
        [x: string]: any;
        /**
         * Decide which summarizer one session uses.
         *
         * The whole session is handed over, not just its id: the plugin resolves the
         * mode from the session's header preset and its id, so an id-only lookup
         * would silently skip the preset key.
         *
         * @param agent - the agent being compacted.
         * @returns `'plugin'` for this plugin's handoff template, `'default'` to
         *   delegate to the shipped backend, or whatever a test seam returns.
         */
        readMode(agent: any): Promise<"plugin" | "default">;
        /**
         * B10 的判据选项：判据 1 只从 `deps` 接，缺省**不接**。
         *
         * **为什么默认不接**：判据 1 问的是「这个文件真的存在于工作区吗」，而这批测试
         * 语料是散文体、全工作区没有 `.rs` 文件，那条判据在那里没有对象；真机上原文
         * 带着工具回执，它才有可用的数据源。所以引擎只提供接口与透传，谁来喂这份清单
         * 是一个还没定的产品决定（真机上的判据 1 接线讨论见 `docs/功能文档.md` 的
         * 判据 1 一节）。
         *
         * `normalizePaths` 也留一个同样的透传口，用途是**测量**：跑出归一化之前的数字，
         * 好让「救了哪些、救错哪些」能对得上。
         *
         * @returns 传给 B10 的选项；两样都没配时是空对象，与加这个口之前逐字相同。
         */
        claimOptions(): {
            normalizePaths?: any;
            fileExists?: any;
        };
        /**
         * 丁：这次改写的护栏用哪一份文件清单。
         *
         * 三态，每一态都要有测试盯着：
         * 1. `deps.fileExists` 是函数 → 用它（嵌入方给的权威清单；测试与真机复算从这里注入）；
         * 2. `deps.fileExists === null` → 明确不接判据 1，护栏不拦（降级）；
         * 3. 没配（`undefined`）→ 引擎自己从这次压缩的原文事件里抽清单（工具回执 + 会话
         *    正文，见 {@link fileListFromMessages}）；抽不到清单时 `oracle` 也是 `null`，
         *    同样是「不拦」。
         *
         * @param messages - 本次压缩的输入消息。
         * @returns 清单与它的来源；`oracle` 为 `null` 即判据 1 不接。
         */
        rewriteFileList(messages: any): CompactionFileList | {
            oracle: any;
            paths: any[];
            receipts: number;
            source: string;
        };
        /**
         * Summarize the replayed region with the five-section handoff instruction.
         *
         * A session whose mode is `'default'` is handed straight back to the shipped
         * implementation. Two sessions in one process can therefore compact
         * differently: one with this template and the live notes, one with the
         * backend's own wording. Nothing else about compaction branches here, because
         * `summarize()` is the only hook this class overrides.
         *
         * @param input - replayed conversation prefix: the derived system head followed by the shadowed region in surface order.
         * @param agent - the agent being compacted; supplies the notes draft, routing, and the mode decision.
         * @param signal - cancellation forwarded to the provider call.
         * @returns the framed summary plus the exact call envelope.
         */
        summarize(input: any, agent: any, signal: any): Promise<any>;
        /**
         * 散文摘要的**只改格式**改写，由 B10 集合差护栏把关。
         *
         * **触发面**：只处理 `classifySummary` 判成 `unrecognised-sections` 的摘要，
         * 也就是用户 2026.09.18 拍板接受的散文形态。形态已合格的摘要一次模型调用都不发。
         *
         * **三条失败路径都退回原散文**，一次都不让压缩失败：
         * 1. 改写调用失败（provider 错误、超时、取消、空输出）；
         * 2. 拿不到模型的思考档位元数据（`resolveModelInfo` 抛错）——此时「锁最低档」
         *    这条用户硬约束无法执行，宁可不改；
         * 3. B10 护栏判出改写**新增**了编造 token。
         *
         * 另外若改写完仍然不是合格形态，也退回原文：这次改写的全部意义就是修形态，
         * 没修好就没有理由动它。
         *
         * @param produced - `runSummarizationCall` 的结果。
         * @param input - 本次压缩的输入（`messages` 是被替换掉的原文）。
         * @param agent - 被压缩的 agent。
         * @param signal - 取消信号，透传给改写调用。
         * @returns 采纳改写后的结果，或原样返回 `produced`。
         */
        rewriteProseLayout(produced: any, input: any, agent: any, signal: any): Promise<any>;
        /**
         * Read the live notes draft for the agent's session.
         *
         * A missing or unreadable draft degrades to "no notes", which reproduces the
         * plain summarizing behavior instead of failing the compaction.
         *
         * @param agent - agent whose session owns the draft.
         * @returns the draft text, or ''.
         */
        readNotes(agent: any): Promise<any>;
    };
    [x: string]: any;
};
export default createContextZipEngine;
