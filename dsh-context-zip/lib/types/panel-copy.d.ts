/**
 * The two long explanations the settings panel shows, and the same two strings
 * its schema fields carry as `description`.
 *
 * They live here, in one module, because they used to live in two places: the
 * schema said one thing and the panel said another, so the sentence a reader
 * found in `settings.yaml` and the sentence the panel showed for the same
 * switch could drift apart without anything noticing. One home means the
 * README, the schema and the panel cannot disagree.
 *
 * Keys are the schema field names they belong to.
 *
 * @module dsh-context-zip/engine/panel-copy
 */
/** What the schema field "fallbackEnabled" means, in the panel's two languages. */
export declare const FALLBACK_ENABLED_COPY: {
    readonly en: "When a compaction keeps failing to produce a usable summary, fall back to a summary the plugin writes itself from the session events, instead of failing the compaction again. Off (the default) reports the failure and leaves the conversation untouched, which is the conservative behaviour: nothing enters the context that a model did not write. On, the compaction always lands, at the cost of a summary that reads like a ledger and carries none of a model summary judgement. The mechanical summary cannot invent anything, because every line of it comes from the events themselves.";
    readonly zh: "压缩尝试连续失败达到「失败几次后兜底」设定的次数时，以插件依据会话事件自行拼写的台账摘要替代模型摘要，使压缩落地。关闭（默认）时，尝试次数用尽即报告失败，旧对话原样保留，上下文中不进入任何非模型撰写的内容。开启时压缩必然完成，代价是摘要形如台账，不具备模型摘要的判断力；该摘要的每一行均来自会话事件本身，不可能编造。";
};
/** What the schema field "rewriteEnabled" means, in the panel's two languages. */
export declare const REWRITE_ENABLED_COPY: {
    readonly en: "Rewrite the FORM of a summary that the shape gate accepted as prose, so a later model can find things in it again. Off by default. It fires only on the summaries the gate reports as \"unrecognised-sections\" — the accepted-but-unstructured ones — never on the tool-call-markup or too-short failures, which go through retry and the mechanical fallback instead. The call receives the summary and nothing else, is asked to change layout only, is pinned to the lowest reasoning effort the model advertises, and is discarded whenever it adds a token the original summary did not have. Any failure keeps the original prose, so this can never fail a compaction.";
    readonly zh: "对形态门判定为无小标题结构的摘要，追加一次仅调整排版的重排调用。该调用只携带这份摘要，不重发被压缩的对话，思考档位固定在模型声明的最低档，且只允许按五段式重排，不得增删事实。重排前后各执行一次编造检查，只要出现原摘要中没有的 token，即丢弃重排结果并采用原摘要；调用失败同样采用原摘要，因此该功能不会导致压缩失败。";
};
