# dsh-context-zip

给 DeepSeek Harness（DSH）写的上下文压缩插件。它顶替宿主自带的压缩摘要器，改成五段式交接摘要，并让被压缩掉的原文可以按事件号读回来。

版本 `0.1.0`，许可 MIT。

## 这是什么

DSH 在上下文接近窗口上限时会压缩会话。默认实现让模型自由写一段摘要，原文从此只能靠捞。本插件接管这一步：

- 摘要按固定五段产出，便于后续模型定位旧信息；
- 每次压缩记录一个段，段号、被替换的事件号、摘要事件号都能列出来；
- 原文不做任何删除，模型和人都可以按段号或事件号读回；
- 模型可以选择写工作笔记，笔记在下一次压缩时并入摘要；
- 提供一整套设置面板，控制以上行为。

插件不修改 DSH 自身代码。它通过 bundle patch 挂载自己，并通过一份 profile 本地的同名包顶替 `compaction-basic` 那一行。

## 给谁用

- 在用 DSH 跑长会话、并且在意「压掉之后还能不能查回来」的用户。
- 想在自己的 DSH 部署里换掉默认摘要写法、又不想改 DSH 源码的用户。
- 需要一份可读的压缩审计材料的用户。

## 依赖什么

- **宿主**：DeepSeek Harness。本插件只在 DSH 宿主里工作，不能独立运行。
- **Node.js**：`^22.19.0 || >=24.0.0`（见 `dsh-context-zip/package.json` 的 `engines`）。
- **宿主提供的包**：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-commands`、`@deepseek-ai/dsh-compaction`、`@deepseek-ai/dsh-compaction-basic`、`@deepseek-ai/dsh-home-paths`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-session-query`、`@deepseek-ai/dsh-settings`、`@deepseek-ai/dsh-system-prompt`、`@deepseek-ai/dsh-token-meter`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`、`react`。这些都是 `peerDependencies`，由 profile 的 `node_modules` 解析，不随本插件安装。
- **安装前提**：`install.mjs` 需要在 profile 的解析路径上找到真实的 `@deepseek-ai/dsh-compaction-basic`，才能复制一份 `base.js`。该包通常由 `$DSH_HOME/profiles/node_modules` 提供，而这个目录是 DSH 首次启动时才生成的。从未启动过的全新 profile 先启动一次再装。
- **宿主版本**：实测通过的是 DSH `0.1.5-rc.2` 与 `0.1.6-alpha.2`；`package.json` 里声明接受 `>=0.1.5-rc.2 <0.2.0-0 || >=0.1.6-0 <0.2.0-0`（其余 0.1.x 版本未逐一实测）。

## 安装三步
**`dsh plugin add` 可以装，装上也能启动，但压缩不会生效。** 它只装插件本体，缺「行重定向」那一件，于是压缩那一行仍解析到内置后端。用下面的 `install.mjs`，并且这个 profile 至少启动过一次；也可以在启动后到设置面板的 ContextZip 一栏点「接上压缩」补上，再重启 harness。



1. 构建。

   ```bash
   npm install
   npm run check        # build.mjs + tsc --noEmit + 两个产物的 node --check
   ```

2. 安装到 profile。

   ```bash
   node install.mjs --profile-dir <profile 目录>
   ```

   例如 `node install.mjs --profile-dir <harness home>/profiles/web`。

   **`dsh plugin add dsh-context-zip` 也能装，但它只装插件本体。** 面板能打开、插件也能启动，**压缩不会生效**：缺的是「行重定向」那一件。点 ContextZip 一栏的「接上压缩」，它把重定向写进 profile 的 `node_modules/@deepseek-ai/dsh-compaction-basic/`，用的是与 `install.mjs` 同一套文件、同一套守卫（目标必须落在 profile 内、被别人的真包占着就拒绝覆盖）。成功之后状态行改成「已接线」并提示「重启 harness 后生效」；重启必须由用户手动做。

3. 重启宿主。DSH 在启动时组合 profile，换行要重启才生效。

更完整的参数说明、卸载与回滚方式见 `docs/安装与卸载.md`。

## 能做什么

### 压缩接管

自动压缩那一步改走本插件的五段式摘要。五段是 `Goal and intent`、`Decisions`、`Current state`、`Next steps`、`Anchors`。摘要软目标 3072 token，硬上限 6144（`engine/prompt.ts`）。

接管是逐行替换，不是并行挂载。`compaction` 是单槽服务，同时加载两个实现会直接报错，所以本插件必须顶替自带的 `compaction-basic` 那一行。顶替手法和原因写在 `dsh-context-zip/README.md`。

接管不等于强迫所有会话都用它。设置里有一个按会话生效的开关，语义是「新建会话用哪种摘要」：开就走本插件，关就把摘要那一步交回内置后端。选哪一段压、保留多少尾巴、超限怎么重试、日志怎么写，两种模式完全一样，差别只在摘要的措辞与笔记。模式是实时读的，改设置立刻影响已经开着的会话。

### 笔记并入摘要

工作笔记默认关。开启后模型可以用 `notes_write` 记下意图与决定，用 `notes_read` / `notes_search` 读回草稿与归档；下一次压缩会把草稿作为「意图材料」喂给摘要器。摘要仍是唯一权威，事实以历史为准，意图以笔记为准。草稿上限 6000 字符，上下文压力到 75% 时提醒一次（`NOTES_MAX_CHARS`、`REMINDER_THRESHOLD_PERCENT`）。

笔记存放在 `<harness home>/context-zip/`，与会话日志分开。

### 检索工具

四个工具按会话自身的历史工作，只读自己，不跨会话、不跨智能体：

| 工具 | 作用 |
|---|---|
| `history_segments` | 列出本会话的压缩段：段号、被替换的事件号、摘要事件号 |
| `history_read` | 按段号、按事件号、或按事件号加字符偏移读回原文 |
| `history_search` | 全文搜索会话历史，带游标翻页 |
| `history_find` | 一次调用试多个查询词，可带正则提取 |

`history_search` 的搜索上界是「请求这次搜索的助手消息之前」，所以一次搜索不会匹配到它自己，也不会匹配当前这一步的推理。游标把上界写进自身，翻页不会重页。

另有只读服务 `contextZip` 与一条 `/zip-export <会话号>` 命令，把分段导成 Markdown，用于人工复查。

### 检索节流

默认关（`throttle`）。开启后有四件事：给每次检索加回执、已完整读过的事件不再重复返回、连续两次零新增后暂停搜索、收窄期间限制单次读取长度。台账与打点文件 `tracePath` 不受这个开关管辖，关着时照常运行，所以未节流的基线仍然可测。

节流的效果从未确立，详见 `docs/局限性与已知问题.md`。

### 摘要兜底

默认关（`fallbackEnabled`）。开启后，压缩尝试连续失败的次数达到设定值（`fallbackAfterFailures`，默认 5，夹在 0 到 10）时，改用插件依据会话事件自行拼写的台账摘要，使压缩落地。该摘要的每一行都来自会话事件本身。关闭时尝试次数用尽即报告失败，旧对话原样保留。

### 排版重排

默认关（`rewriteEnabled`）。对形态门判定为「无小标题结构」的摘要，追加一次仅调整排版的调用：只把散文重新排成五段式，不重发被压缩的对话，思考档位固定在模型声明的最低档，并对「改写里有、原摘要里没有」的路径 token 做一次存在性判决（`introducedPaths` / `sameFileSpelling` / `rewriteGuardBlocks`），判不出存在的就丢弃重排结果。调用失败、元数据取不到、护栏判退都只是少一次排版改善，不会让压缩失败。

### 设置面板

面板里多一节 `ContextZip`，分五块：压缩方式、摘要兜底、摘要重排、实验与排障（默认收起）、压缩分段。输入框左下角那一排多一个小芯片，显示当前会话下一次压缩会用哪个后端，点一下就能换，写的是按会话号的覆盖行。

按会话覆盖表在面板上只读：唯一写入口是那个芯片，或者手工改 `settings.yaml`。

## 怎么自己验证

插件自带一套运行时检查，当前条数为 1130。检查的是构建产物，需要指向一份装好的副本。完整说明见 `evidence/套件说明.md`，最短路径是：

```bash
node build.mjs
node install.mjs --profile-dir <测试 profile>
node test/run.mjs --installed <测试 profile>/node_modules/dsh-context-zip --deliverable <本目录>
```

两个参数都要给。`--installed` 让检查能解析 `@deepseek-ai/*` 并拿到宿主自带的压缩后端；只跑本目录会在加载阶段报「找不到包」或让加载守卫假报失败。`--deliverable` 让同一个检查同时核对本目录 `package.json` 里 `exports[*].types` 指向的声明文件是否真的存在。

## 边界与已知问题

- 只支持 DSH 宿主，不能独立运行。
- 工作笔记功能默认关。
- 检索节流的效果从未确立，默认关。
- 设置面板里的会话名最长 60 秒才更新一次。
- 标题备忘录没有容量上限。
- 按会话覆盖表在面板上只读。
- 安装器只做文件拷贝，不构建；升级 DSH 之后需要跑 `--check` 确认重定向有没有落后。
> 说明：`redirect/` 是一个**本地重定向包**，它刻意沿用 `@deepseek-ai/dsh-compaction-basic` 这个包名，用来把宿主的后端调用接到本插件上。它**不是 DeepSeek 官方包**；该包标了 `private: true`，安装器也拒绝覆盖真实包。

逐条的依据与影响写在 `docs/局限性与已知问题.md`。

## 许可

MIT。全文见 `LICENSE`。

## 目录导览

| 位置 | 内容 |
|---|---|
| `README.md` | 本文件 |
| `README.en.md` | 英文版 |
| `RELEASE-NOTES.md` | 本次发布的说明 |
| `LICENSE` | MIT 许可全文 |
| `docs/功能文档.md` | 功能与代码位置的索引 |
| `docs/结构与文件职责.md` | 逐文件说明各自负责什么 |
| `docs/安装与卸载.md` | 安装器参数、卸载与回滚 |
| `docs/局限性与已知问题.md` | 边界、已知问题与其依据 |
| `docs/同类插件对比.md` | 与同类插件的对照，含我们不如别人的地方 |
| `evidence/套件说明.md` | 测试套件怎么跑、覆盖什么 |
| `evidence/对照测试方案.md` | 压缩效果对照测试的方案 |
| `evidence/对照测试最终报告.md` | 对照测试的结论 |
| `evidence/token消耗与性价比分析.md` | token 消耗的统计 |
| `evidence/独立验收报告汇编.md` | 独立验收的原始报告 |
| `evidence/验收台账.md` | 验收切片的状态表 |
| `dsh-context-zip/` | 插件本体（要装进 profile 的就是这一份） |
