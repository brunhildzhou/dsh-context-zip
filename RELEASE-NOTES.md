# 发布说明

**版本**：`0.1.8`
**日期**：2026.09.24（北京时间）
**对应内部快照**：`内部开发快照`
**许可**：MIT

## 0.1.8 改了什么

**压缩触发阈值改回只由配置里的比例决定：宿主从 `0.1.7-alpha.1` 起把压缩触发阈值改成「窗口 × 比例」与「窗口 − 输出预留 − headroom」两项取小，本机上第二项只有窗口的 51.6%，`thresholdRatio: 0.8` 被架空，压缩触发远早于配置值。插件接管压缩行时把复制过来的 `base.js` 里那一处表达式定点改回只有比例的形式，认不出的后端默认拒绝接线。同一版修掉「重定向装过一次之后就再也刷不了」的后端解析缺陷。除压缩触发时机外，分段目录、检索工具与设置面板的行为与 0.1.7 相同；界面未改，面板暂不显示补丁状态。**

### 修掉：压缩触发阈值被宿主的第二项上限架空

- **症状**：接管生效的 profile 上，压缩触发得比配置早得多。本机窗口 400000、请求头预留输出 128000、默认 headroom 65536，实算触发线 206464，约窗口的 51.6%；配置里 `thresholdRatio: 0.8` 本应给出 320000。
- **根因**：宿主从 `0.1.7-alpha.1` 起把阈值写成 `Math.floor(Math.min(contextWindow * policy.thresholdRatio, pressureBudgetTokens))`，其中 `pressureBudgetTokens` 是窗口减去输出预留与 headroom。第二项比比例那一项小时，比例就不参与决定了。跨版本核对：`0.1.5-rc.3`、`0.1.6-alpha.1`、`0.1.6-alpha.2` 的阈值只有比例那一项，`0.1.7-alpha.1`、`0.1.7-alpha.2`、`0.1.7-rc.1` 是两项取小。
- **修法**：接管压缩行时把复制出来的 `base.js` 里那一处表达式定点替换回 `Math.floor(contextWindow * policy.thresholdRatio)`。这是一处锚定字符串替换，不重新实现阈值计算，所以拷出来的 `base.js` 除那一行外与宿主原文件逐字节相同（实测 49408 字节变 49376 字节，差的正是 `Math.min(` 与 `, pressureBudgetTokens`）。命令行 `install.mjs` 与面板按钮背后的 `wireCompactionRow` 走同一份判定（`src/threshold.ts`，独立构建入口 `lib/threshold.js`），避免只改一条路径：按一下面板按钮就把未补的后端装回去。
- **三态与护栏**：后端是两项取小时改写成比例一项，戳里记 `patch: ratio-only`；后端本来只有比例时原样拷贝，戳里记 `not-needed`（否则无法区分「宿主本来就不需要补」与「补丁没生效」，这两件事在字节层面一样）；既不是两项取小、也不是只有比例一项，或两种形态都出现多次时拒绝接线，并且在删任何东西之前就拒绝，已接好的重定向保持原样可用。命令行加 `--stock-backend` 才按原样接线（不补），戳记 `none`；面板按钮没有参数，遇到这种后端只会拒绝，报错指向这个开关。选择拦住，是因为宿主以后改了表达式的写法，替换就会落空，而落空后照旧安装的表现是「装上了、也报成功，阈值还是 51.6%」，这种失败不报错，只能靠人比对字节发现。
- **写后自检**：写完 `base.js` 立刻读回，字节与判定不符就把重定向目录删掉再报错。这个文件就是宿主实际加载的东西，戳不能记一个字节里并不存在的状态。
- **为什么整项去掉第二项**：128000 + 65536 = 193536，高于比例留给 0.8 的 80000，保留第二项就到不了 320000，没有中间解。
- **`--check` 与 `/wire`**：`--check` 除原有版本比对，再读 `base.js` 的实际形态并输出一行 `redirect patch ...`；戳承诺 `ratio-only`／`not-needed` 而文件不是那个形态，或戳里没有 `patch` 键而文件是未补形态时，按落后处理，退出码 1（三种退出码不变：0 同步、1 落后、2 未安装）。它也不再因为解析不到后端而硬失败：版本读不到就报 unknown 且不据此判落后，补丁状态行照常读。`/wire` 状态新增 `patch`（戳里记的状态）、`patchObserved`（从字节回读的形态）、`patchDrift`（布尔）三个字段；界面这次没有改，面板暂不显示这三个字段。
- **影响面**：只在接管生效的 profile 上生效，没有接管的 profile 用的仍是宿主自带的压缩行。补丁在接线时写进 profile 里那份 `base.js`，所以已经接过线的 profile 要再跑一次接线（面板按钮或 `install.mjs`）才拿得到，在那之前 `--check` 会把未补的旧重定向报成落后。代价是压缩发生得更晚、单次请求携带的上下文更大，与配置里的 `thresholdRatio: 0.8` 一致，比宿主 0.1.7 的默认行为更贵。
- **宿主校验这一侧**：那条 `retainTokens < thresholdTokens` 只会更宽松，补丁把阈值抬高（本机 206464 到 320000），补丁前后两种都满足。小窗口模型上未补的后端更直接：窗口装不下 65536 的 headroom 时 `pressureBudgetTokens <= 0` 抛错，压缩配置构建失败；补过之后阈值只由比例决定，不再依赖 headroom。

### 修掉：重定向装过一次之后就再也装不了

- **症状**：重定向装上之后，刷新重定向的命令自己读不到要拷贝的源，抛 `cannot locate a shipped @deepseek-ai/dsh-compaction-basic`。这是先前就存在的缺陷，第一次真机重装才暴露。
- **根因**：`basePackageDir()` 从 profile 出发按 Node 的查找路径找宿主后端。重定向一旦装上就顶替了 profile 里 `@deepseek-ai/dsh-compaction-basic` 这个说明符，而宿主真身在包管理器 store 里（`.pnpm` 下），不在查找路径上；查找路径上的其它候选（`DATA/profiles/node_modules`、`DATA/node_modules`、工作区 `node_modules`）也都解析不到这份包。
- **修法**：安装路径与面板按钮路径（`wireBackendDir`）都加一层兜底：先走原有解析，失败就读戳里记的 `source`（那条路径仍在、且不带 `context-zip` 版本标记时用它）；两条都不通则拒绝安装，并提示把一份真包放到 profile 上一级的 `node_modules/@deepseek-ai/dsh-compaction-basic`。`--check` 也改用这层兜底。
- **验证**：真机上同一条命令从抛错变为成功，安装输出 `threshold patch: ratio-only`，装完 `--check` 报 `ratio-only (base.js carries ratio-only)` 与 `in sync`、退出码 0。

### 验证

- **反向对照（两次）**：只把改写去掉、留着写后自检，自检当场拦住，报 `wrote .../base.js but read back stock: removed the redirect rather than leave an unverified backend in place`；把改写与写后自检一起去掉，本次新增的判据变红，说明这几条判据确实能失败。
- **实机（隐藏桌面隔离实例，宿主 `0.1.7-rc.1`，从交付树安装）**：`--check` 报 `ratio-only (base.js carries ratio-only)`、退出码 0；`/wire` 的 `patch` 与 `patchObserved` 都是 `ratio-only`、`patchDrift` 为 `false`，`copiedAt` 早于 `processStartedAt`，说明这次启动加载的就是补丁后的后端。把 `base.js` 换回未补字节重启做对照：`--check` 报落后、退出码 1，`patchObserved` 翻成 `stock`，`patchDrift` 变 `true`。
- **本机真实 profile**：装好并重启宿主后，3080 的 `/wire` 回报 `patch` 与 `patchObserved` 都是 `ratio-only`、`patchDrift` 为 `false`，落地 `base.js` 49376 字节，两项取小形态 0 处、只有比例形态 1 处。
- **没验到的**：运行时阈值数字本身没有直接观测（要发一次真实模型请求），这一条只到「宿主加载并执行了补丁后的那一行」为止；`not-needed` 与「认不出后端时拒绝接线」两态在实机上没走，由套件覆盖；实机只覆盖宿主 `0.1.7-rc.1` 一个版本、一个 profile。

## 0.1.7 改了什么

**修掉一处设置来源的误报：`schemastery` 停在 3.18.1/3.18.2 的 profile 上，宿主 `settings.describe()` 会把本插件那一行整行丢开，于是 `/live` 的 `source` 把用户设过的值报成 `default`，`rowConfigured` 恒 false——后者在重定向槽位未生效时会把「需要迁移设置」误报出来。同一版给会话格式补了一条防守判据。压缩接管、分段目录、检索工具与设置面板的行为与 0.1.6 相同。**

### 修掉：`/live` 的 `source` 误报 `default`

- **症状**：`schemastery` 是 3.18.1 或 3.18.2 的 profile 上，面板把「接管」那一项的来源标成 `default`，`/live` 载荷里的 `source` 也这么答，而用户明明在设置里开过这一项。
- **根因**：`source` 由 `settingsState.userEnabled`（连同 `userAgents`、`userRetrieval`、`userRetrievalAgents` 同组记录）决定，这组记录只从 `settings.describe()` 里那一行的 `user` 层投影出来。宿主的 `describe()` 对**没有 volatile 字段的行整行丢弃**，而 `Schema.volatile()` 是 `schemastery` 3.18.3 才加的 API：3.18.1/3.18.2 上这个方法不存在，本插件那一行的 schema 于是一个 volatile 字段都没有，`describe()` 对它答 `[]`。用户段并没有从 profile 里消失，丢的只是那一次读。
- **连带误报**：`rowConfigured` 同样恒 false，而 `/wire` 的 `readAttention` 正是拿它在状态为 `inactive` 时决定报不报 `migrate`（「设置未迁移」）。一个行配置齐全、只是重定向槽位还没接上的 profile，会被这套读数说成「需要迁移设置」。
- **修法**：`describe()` 报不出这一行时，改从配置编辑器读同一层——`ctx.get('configEditor').configuration()` 里按 `entry.options.id === ns` 找到本插件那一行，取其 `override`。这份 `override` 正是宿主投影自己 `user` 层的输入，所以两边都能读到时逐字一致；`describe()` 能报出这一行时仍以它为准。编辑器是可选服务，这条读法每一步都带防守：profile 里没有编辑器、或者读一次抛错，都答 `undefined`，`rowConfigured` 与其余记录落回改动前那个「全空」答案。
- **`revision` 不变**：它是设置服务自己记的写入次数，全进程只有那一处保留，所以报不出这一行时仍是 `undefined`，与这次改动之前一样。
- **不受影响的**：设置的实际生效值仍走 `scope.get()`，引擎选路与压缩行为都不碰这组记录。

### 新增判据：会话格式的防守

- **为什么**：0.1.4 那条守卫是**文本**的（三个 bundle 里不许出现退役的 `kind: 'plugin'`）。宿主哪天把会话信封里的某个字段改名，文本守卫看不见，插件却会照着旧字段名读出一个错的数。
- **判据**：`test/fixtures/session-v4-log.json` 是一份冻结的 V4 逻辑会话（`{ header, inheritedEventCount, events }`，字段名全部取自已装包的声明）。先把它交给**宿主自己的** `Session.create` 重建，那是这个格式的准入边界，会校验头部版本、事件信封、seq 连续性、每条消息的来源，以及 `surfaceOp`/`sourceEventSeqs` 描述的表面迁移；再把重建结果喂进插件真实的读取路径与分段目录，比对派生的段号、被替换事件号与摘要事件号。
- **失败面**：宿主改了信封或头部，`Session.create` 直接抛；宿主改了它自己不做 schema 校验的载荷字段，重建照样成功而派生出来的数字不对。两条路都让这一条变红，插件不会静默去读一个它已经不认识的格式。
- **宿主从哪来**：`--installed` 点名了插件目录时，宿主包从那棵目录解析，读到的就是 profile 实际加载的那一份；fixture 始终读本仓库这一份，因为冻结的期望是本仓库的。

### 文档口径

- 套件 **1358 → 1360**（`--installed` 加 `--deliverable` 一档）。新增的两条是会话格式那一条与这次 `source` 修复的回归判据。
- 文档里不可复现的条数换成实测值：`README.md`、`README.en.md`、`dsh-context-zip/README.md` 与 `docs/功能文档.md` 两处的 `1358`，`docs/局限性与已知问题.md`、`evidence/验收台账.md` 的同一口径，都改成 `1360`；`evidence/套件说明.md` 的 `1359` 改成 `1360`。
- 交付树自己当运行主体时（不带开发依赖）：不接 `--deliverable` 是 **1346** 条总数，接上 `--deliverable .` 是 **1356** 条总数，唯一失败仍是按设计的 `typescript` 探针那一条（`build exit code: typescript is reachable for the third case`）。镜像树实测同数。

**套件**：`--installed` 加 `--deliverable` 一档 **1360** 条全过，`tsc --noEmit` 零错误。

## 0.1.6 改了什么

**一批面向发布物的修正：面板提示词不再让 AI agent 去跑那个会把插件本体拷进 profile 的安装脚本，改走插件自己的接管路由；提示词里关于 `stale` 的判据纠正成读一次就该翻；`schemastery` 的 peer 下限退到已知能跑的最低版本；落地页接上六张截图。压缩接管、分段目录、检索工具与设置面板的行为与 0.1.5 相同，套件条数不变。**

### 提示词：接管动作改走插件自己的路由

- **旧写法的问题**：A/B/C 三段提示词（未生效、待更新、接管异常）原来让 agent 跑 `npm i dsh-context-zip@latest --legacy-peer-deps` 再 `node install.mjs --profile-dir …`。`install.mjs` 会把插件本体拷进 profile，破坏 pnpm 对它的管理，而且它只有 `--check`，没有「只刷新重定向」的口子。
- **新写法**：调插件自己的接管路由 `curl -s -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:{port}/dsh-context-zip/wire`，与面板按钮走同一条路由。它只重写 profile 里那份重定向（`package.json`、`index.js`、`base.js` 与版本戳），不碰插件本体，升级仍走 `dsh plugin add`。路由要求 JSON content-type，裸发会被 415 拒。
- **兜底**：未生效那一段把 `dsh plugin add` 降为第二步兜底，只在接管报「本插件的 redirect 文件缺失」时使用。

### 提示词：`stale` 判据纠错

`stale` 是每次读 `/wire` 现算的（拿盘上 shipped 后端版本与戳比），接管写完戳就该是 `false`。原提示词写成「可能仍为 true，要等重启后重读才翻」，把正常接管说成了不确定状态。现在写成：接管后重读应看到 `wired:true`、`stale:false`、`copiedAt` 晚于 `processStartedAt`；本次进程里状态显示「等待重启」，重启后生效。

### peer 下限：`schemastery` 从 `^3.18.2` 退到 `^3.18.1`

- **实测**：`Schema.volatile()` 只在 3.18.3 存在（3.18.1 无、3.18.2 无、3.18.3 有）。原下限向 3.18.2 承诺了它没有的能力，又把实际能跑的 3.18.1 判成不受支持。
- **降级表现**：插件对 `volatile()` 只有一处防御式调用（`liveField()`）。拿不到时丢的是设置页自动表单与设置服务写入通道，行配置读取与插件面板写入不受影响。README 与 `docs/功能文档.md` 都写明了这段口径。

### 落地页接上六张截图

- 四态（未生效、正在接管、已生效、等待重启）取自隐藏虚拟桌面里的临时 DSH 实例（临时 `DSH_HOME`、端口 3190、插件 0.1.5），元素级取景，天然不含标签页、地址栏与左侧会话栏。
- 检索工具输出与五段摘要两张由本地桩模型驱动，只展示界面形态，**不作为能力或效果证据**；README 与 `docs/截图清单.md` 都标了这一点。
- 六张图都经重编码（PNG 块只剩 `IHDR`/`IDAT`/`IEND`）并做过字节扫描。
- `dsh-context-zip/README.md` 换成落地页副本给 npm 页面用，原开发 README 挪到 `docs/开发说明.md`；包内那份的图与英文页链接走 GitHub 绝对地址。

### 文档口径修正

- `evidence/套件说明.md` 与本文里不可复现的 `1272` 换成实测的 `1344`（交付树自己当运行主体时，唯一失败是按设计的 typescript 探针）。
- `evidence/套件说明.md` 补上「1358 需先装 devDependencies」的前提，以及构建时序提醒：改了 `client/index.ts` 或 `test/run.mjs` 之后必须重跑 `node build.mjs`，否则会出现「期望是新的、包还是旧的」假红（2026.09.23 真出现过一次）。

### 没变的

- 套件条数仍 **1358**（`--installed` 加 `--deliverable` 一档），`tsc --noEmit` 零错误。
- 压缩接管、分段目录、四个检索工具、导出与设置面板的行为与 0.1.5 相同。

## 0.1.5 改了什么

**面板标题行多了一颗问号，接管出问题时才出现，点开是一段可以直接交给 AI agent 的修复提示词；同时修掉「读当前内置后端版本」的缺陷，在 DSH `0.1.7-alpha.1` 上落后的重定向不再被误报成「已生效」。**

### 新增：接管异常时的修复提示词

- **落点与判定**：标题行保存按钮之后多一颗问号，只在 `/wire` 载荷里的 `attention` 非 `null` 时渲染。这个字段由宿主半边按同一次状态读数分类，客户端不自己猜；状态健康（已生效、正在接管）时是 `null`，被别人的真包占着那一态（`foreign`）也是 `null`（那里没有本插件能修的东西），旧服务端根本不发这个字段——三种情况都不画问号，所以「没有可修的东西」与「对面不认识这个字段」落到同一个结果。
- **七种状态各一句现状**：未生效、待更新、设置未迁移、等待重启、接管不完整、接管失败、状态未知。其中 `migrate`（设置未迁移）只在本插件那一行没有任何用户值、且 home 下的 `settings.yaml.imported`（或尚未改名的 `settings.yaml`）里还留着顶层 `context-zip:` 段时给出，优先级高于「未生效」——设置没跟过来时先搬设置，再谈接管；它是唯一会读文件系统的一种，且只读。
- **气泡内容**：一句现状 + 提示词正文 + 复制按钮。复制按钮只复制正文，现状那一行是给读者的上下文，不是要交给 agent 的东西。正文里的 `{home}`、`{profile}` 取自服务端读数，`{port}` 取自页面地址，渲染与复制都换成真值，不是占位符。
- **重启留给用户**：`restart`（等待重启）这一态没有正文、也没有复制按钮，只写一句「重启宿主后生效」；其余每一段正文都写明「全程不需要界面操作」，并以「不要自行重启 DSH」收尾。提示词既不要求 agent 操作界面，也不要求它重启宿主。
- **两套文案各九对键**：中文与英文各新增 `helpTopLabel`、`helpTopCopy`、`helpTopWhere`、`helpTopRestart`、`migrateMain`、`promptInactive`、`promptUpdate`、`promptMigrate`、`promptRepair`。套件里那条 `both locales define the same keys` 钉住两套的键集合一致。
- **新增判据**：`attentionKind` 的十种输入组合（含「落后压过待重启」「缺戳不算待重启」「进程启动时间不可解析不算待重启」「`null` 读数按未生效而不是失败」）；`attentionPrompt` 的占位符替换、复制文本等于正文、「`restart` 没有可复制正文」、以及「本 build 不认识的 kind 整个不画」；`readAttention` 的 `migrate` 前置条件（含「缩进过的同名字段不算顶层段」「两份文件都没有时不报迁移」「拿不准那一行有没有用户值时不报迁移」）；路由把 `readAttention` 的答案原样放进 GET 与 POST 两种答复，并为读失败与动作失败各带一个 forced kind；面板只在 `attention` 非 `null` 时画第 4 颗问号，且它开合、`aria-label`、`aria-describedby` 都与既有那颗同一套。

### 修掉：读当前内置后端版本

- **症状**：在 DSH `0.1.7-alpha.1` 上，重定向包住的内置后端版本比宿主旧时，面板报「已生效」而不是「待更新」，右端的「重新接管」也不出现，用户没有任何线索去修它。
- **根因**：`basePackageDir` 只探 Node 从 profile 出发的查找路径。0.1.7 的升级会重写 harness 自己的 store，profile 一级的 `profiles/node_modules/@deepseek-ai/dsh-compaction-basic` 软链仍指向已被删掉的旧 store 目录，于是每一个候选都读不到清单，函数抛错，`current` 恒为 `null`；面板按「版本未知不判落后」处理，`stale` 也就恒为 `false`。版本读不出来恰恰发生在它变了的那一刻，而那正是这个比较存在的理由。
- **修法**：再探一遍运行中 harness 自己的查找路径。锚点是本进程入口 `process.argv[1]` 解析软链后的真路径（真机上是 harness 的 `bin.js`），逐级向上探 `<祖先>/node_modules` 与 pnpm 的 `<祖先>/node_modules/.pnpm/node_modules` 提升位。profile 那半优先，因为健康 profile 上要读的就是插件旁边那一份；两半都必须读到可读清单，并且都拒绝本插件自己的重定向 marker（`version` 里带 marker 的那份不算内置后端）。两处都找不到仍然抛错，不编一个版本出来。
- **回归判据**：用一份临时布局钉住三件事——profile 一级读不到时能从宿主自己的查找路径解析出 `current` 并据此判出 `stale`；两条路径都没有时 `current` 保持 `null` 且不报落后；宿主那一份带 marker 时不算内置后端。

**套件**：`--installed` 加 `--deliverable` 一档 **1358** 条全过。

## 0.1.4 修了什么

**修掉一个会让整轮对话卡死的缺陷：插件注入的消息带着退役的 `kind: 'plugin'`，被 DSH `0.1.7-alpha.1` 的 v4 会话格式在写入时拒收。** 0.1.3 的说明里写过「消息来源 kind 自声明……零运行时影响」，那句话是错的：类型声明只让 `tsc` 过关，落盘 JSON 仍然写 `'plugin'`，而 0.1.7 恰恰拒收这个字面量。

- **症状**：处于插件接管模式的会话，上下文压力到 75% 时注入一条笔记提醒，网页立即报 `本轮运行失败 format v4 message requires a producer-owned source kind`，那一轮的事件一笔都没落盘，此后每次发消息都失败。真机上已复现：一个跑了两百多轮的会话在 2026-09-23 10:31 起无法再接住新消息，日志停在子智能体完工那一笔，会话文件本身没有损坏。
- **根因**：0.1.7 删掉了通用的 `plugin` kind，改为各生产者自声明，并在会话格式的**读写两条路**上拒收这个退役字面量（`@deepseek-ai/dsh-session-format-v3-to-v4` 的 native source admission 见到 `kind === 'plugin'` 直接抛错）。插件四处构造点里，只有笔记提醒会落盘，另外三处只进模型请求。
- **为什么插件自己拦不住**：`agent.inject()` 只把消息排进收件箱并立即返回，真正落盘发生在 agent loop 的 `session.append` 里，插件的 `try`/`catch` 看不到，所以既没有插件日志，也只有整轮失败这一个信号。
- **修法**：四处构造点统一改用常量 `PRODUCER_KIND`，值为 `plugin:<插件名>`，即 `plugin:context-zip`。这个写法与宿主自己的约定一致：它的 V3 迁移把老日志里 `{ kind: 'plugin', plugin: X }` 一律改写成 `kind: 'plugin:X'`，所以新消息与盘上已有的那些一致。`plugin` 字段保留：机械摘要按它过滤插件自己的指令消息。类型声明同步改成 `'plugin:context-zip'`。
- **回归判据**：新增「三个 bundle 里不许出现退役的 `kind: 'plugin'`」「笔记提醒必须由共享常量构造」「摘要指令的 kind 必须是 `plugin:context-zip` 且保留 `plugin` 字段」。先在未修的交付树上验证过这几条会红（4 条失败），修完全绿。
- **升级后怎么恢复被卡住的会话**：装上新版并重启宿主即可；期间为该会话关掉的「接管」开关可以在配置里删掉，重新交回插件压缩。

## 0.1.3 改了什么

**适配 DSH `0.1.7-alpha.1` 的新设置子系统（`SettingsForms`）。** 0.1.7 换掉了设置接口：`settings.register`、`installSection`、`get` 一并删除，插件改成把自己的 profile 行当作设置存储，由 Loader 解析后通过 `apply` 的第二个参数交进来，字段标成 `volatile()` 才能进设置文档。

- **老路径原样保留**。`settings.register(SETTINGS_NS, ContextZipSettings, …)` 那一行没动，仍装在 0.1.5/0.1.6 上；用户停在哪条线就还在哪条线。
- **按特征检测分流**，不按版本号：`usesForms = typeof settings.register !== 'function'`。新路的接线是 `settings.configure({ auto: false }, ctx.fiber)`（插件自带面板，所以不让 harness 再生成一张通用页）、读写走 `settings.replace`、重读挂在 `ctx.on('loader/volatile-update')`。
- **新增 `Config` 导出**，十一项设置抽成一张 `settingsFields` 表，`ContextZipSettings` 与 `Config` 都由它生成，避免两处默认值和说明漂移。每项用 `liveField()` 逐字段探测 `volatile()` 是否可用（profile 里那份 schemastery 是 3.18.1，没有这个方法；harness 自带的是 3.18.3），并用 `CONFIG_IS_LIVE` 记录本进程能否承载实时配置。`Config` 必须挂在 `default` 导出上，因为 Loader 归一化 ESM 时取 `exports.default ?? exports`，只做具名导出它看不到。
- **消息来源 kind 自声明**。0.1.7 删掉了通用的 `plugin` kind，改为各生产者自己登记。插件用一段纯类型的 `declare module '@deepseek-ai/dsh-llm'` 把自己的 `kind: 'plugin'` 登记回去，与官方 `dsh-schedule` 同款写法。**零运行时影响**：消息本来就带这个 kind，改的只是类型。
- **peer 范围补上 0.1.7 预发布版**：原范围 `>=0.1.5-rc.2 <0.2.0-0 || >=0.1.6-0 <0.2.0-0` 按 semver 规则**不覆盖** `0.1.7-alpha.1`（预发布版只被同级或更低的比较器接受），故追加 `|| >=0.1.7-alpha.1 <0.2.0-0`。已用 semver 7.8.5 实测：`0.1.7-alpha.1` 由 false 变 true，其余版本判定不变。
- **套件**：`--installed` 加 `--deliverable` 一档 **1273** 条全过，与 0.1.2 持平，无回归。

## 0.1.2 修了什么

**修掉一个会毁掉安装的缺陷**：`install.mjs` 复制插件时用**绝对路径**判断哪些目录不该进 profile，而 npm 与 pnpm 装出来的副本本身就住在 `node_modules/` 里，于是根目录被这个判断命中、整份复制被跳过；可脚本在这之前已经把 profile 里的插件目录删掉了，结果插件被删而不补，屏幕上仍打印「安装成功」。

- 受影响场景：先用 `dsh plugin add dsh-context-zip` 装（副本落在 `node_modules/`），再照文档跑那份副本里的 `install.mjs` 补接线。
- 修法：改成按**相对插件根目录**的路径判断。
- 从源码检出跑 `install.mjs` 的常规路径不受影响。

## 这一版改了什么（相对 0.1.0）

1. **压缩引擎不再是独立的第三个包。** 引擎改为插件自身的子路径导出（`dsh-context-zip/engine` 与 `dsh-context-zip/engine/prompt`），只装插件本体也能启动；行重定向仍然单独安装。
2. **设置面板新增「压缩后端」行**，排在「压缩方式」组第一行：左标题带问号气泡、中间主行加副行、右端一颗按钮，共九态。未接管时点「接管」把重定向写进 profile，重启一次 harness 后生效。
3. **`dsh plugin add dsh-context-zip` 现在能装、能启动，但压缩不会生效**：它只装插件本体，缺行重定向。补上用面板的「接管」，或跑 `install.mjs`。
4. **「等待重启」按真实信号判定**：重定向里那份戳的 `copiedAt` 比本进程启动时间新，才算等待重启；不再看「新建会话默认压缩方式」那个设置开关。
5. **时间格式统一为本地 `MM-DD HH:mm`。** 套件条数：`--installed` 1268 条、交付树指向本包 1273 条，全过。

## 这一版是什么

`dsh-context-zip` 是一个给 DeepSeek Harness 用的上下文压缩插件，接管会话压缩那一步：产出带结构的五段式交接摘要，把被压掉的原文做成可回查的分段目录，并提供检索工具、可选的模型工作笔记、机械摘要兜底、散文摘要的排版重排，以及一个设置面板。

插件不修改 DSH 自身代码，不往会话日志里写任何事件。

## 包含哪些目录

| 目录或文件 | 内容 |
|---|---|
| `dsh-context-zip/` | 插件本体，含宿主半边、浏览器半边、包内的压缩引擎、行重定向包、构建脚本、安装器与测试套件 |
| `docs/` | 功能文档、结构与文件职责、安装与卸载、局限性与已知问题、同类插件对比 |
| `evidence/` | 套件说明、对照测试方案、对照测试最终报告、token 消耗与性价比分析、独立验收报告汇编、验收台账 |
| `README.md` / `README.en.md` | 中文与英文的使用说明 |
| `RELEASE-NOTES.md` | 本文件 |
| `LICENSE` | MIT 许可全文 |

## 对应哪次内部快照

对应内部快照 `内部开发快照`。

**发布副本与那份内部快照不是逐字节相同**：发布前做过一次脱敏，把开发机绝对路径、真实会话号、凭据一类换成了尖括号占位符，因此产品副本里的部分注释、安装示例与测试夹具与内部快照有差异。差异只限这类占位符，代码逻辑与判据不变，套件条数也不变。内部开发资料（过程台账、内部快照目录）不随本包发布，正文里凡引用它们的地方都写明了「未随本包发布」。

## 套件

当前 **1396** 条检查通过（源码树为运行主体，同时用 `--deliverable` 指向交付树做声明文件与来源 kind 检查；只给 `--installed` 不给 `--deliverable` 是 **1386** 条）。发布树自己当运行主体这一档这次没跑成：发布树不带 `node_modules`，`test/build/lib/segments.js` 解析不到 `@deepseek-ai/*`，直接报 `Cannot find package '@deepseek-ai/dsh-llm'`；要跑这一档得先给发布树种 peer 软链。跑法与覆盖范围见 `evidence/套件说明.md`。

## 已验证到什么程度

压缩主流程、检索工具与节流、机械兜底与排版重排、设置与路由、面板文本与结构、面板重写、会话标题、整页保存这八大类都有套件判据覆盖；面板只读列表的渲染形态、`显示更多` 的封顶与步长、问号气泡的定位与翻转这三样没有写进套件，靠一次性渲染 fixture 与真机验收覆盖。逐条边界与已知问题见 `docs/局限性与已知问题.md`。

## 许可

MIT。全文见 `LICENSE`。
