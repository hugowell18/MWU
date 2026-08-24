# Layer 2 / Layer 3：Methodology Atlas 预想、当前实际与 Gap 补齐方案

版本：v0.2

日期：2026-08-24

状态：工程与方法对齐说明；本文件不代表客户已批准最终研究方法

## 1. 结论

我们之前把事情想复杂了。

Methodology Atlas 已经给出了足够清楚的主流程。对每个 recording，客户侧最关键的 Layer 2 输入仍然只有：

1. 人工校正完成的 Golden L1b TextGrid；
2. 与之对应的、按 speaker 标记的 verified verbatim transcript TXT。

原始 WAV、L1a speaker mapping、session identifiers 和 L1 时间轴证据来自现有工程，不需要客户重复提供。客户的 annotation conventions / definition set 属于整项研究共用的方法定义，也不是每个 recording 都要附带一份的新输入。

凭 `Golden TextGrid + verified TXT + 系统已有的 L1/WAV`，可以完成 Phase III，并可以使用明确标记为 provisional 的研究定义继续完成 Phase IV 和 Phase V，得到一套可检查的 Layer 2 输出和 Layer 3 analysis matrix。

需要严格区分：

- **工程可运行**：整条链路能够生成结果；
- **provisional research output**：使用了我们暂定并留有版本记录的方法；
- **final research release**：客户 definition set、study schema 和抽样校验完成后才能确认。

缺少客户最终定义不会阻止我们跑通工程，但会阻止结果被声明为客户批准的最终研究结果。

## 2. Methodology Atlas 原先的系统预想

Methodology Atlas 是 Layer 2 / Layer 3 的主合同，不应由 feasibility 脚本中的临时实现反向定义。

### Phase III — Transcript Splitting & Unit Extraction（L2）

**Input**

- Researcher-reviewed L1b TextGrid；
- reviewed transcript；
- coding conventions。

**Processing**

- 按 canonical speaker 拆分 transcript；
- 保留 fillers、repetitions、false starts、repairs、`[bc]` 和 excluded material；
- 生成 RAW / TIDY transcript；
- 提取 turn、utterance、AS-unit 和 clause boundaries，无法自动确定的边界进入 review。

**Output**

- RAW / TIDY transcripts；
- utterance units；
- AS-unit / clause map；
- 交给 Phase IV 的 reviewed transcript corpus。

### Phase IV — Lexical / MWU & Pause-Location Features（L2）

**Input**

- Phase III transcripts and units；
- Phase II nine-label timing package；
- research definitions。

**Processing**

- lexical features；
- MWU identification and statistics；
- clause / AS-unit measures；
- label-aware pause-location classification；
- speech / articulation rate 等 rate measures。

**Output**

- lexical / MWU tables；
- clause / AS-unit tables；
- label-aware pause tables；
- rate tables；
- 交给 Phase V 的 research feature package。

### Phase V — Database Synthesis & Research Export（L2 / L3）

**Input**

- nine-label metrics；
- signed FTO；
- Phase III–IV features；
- study metadata / study schema。

**Processing**

- 合并上游特征并保留来源；
- 按 study schema 形成 long-format observations；
- 同时保留 P025 / P035 threshold 维度；
- 执行 schema、完整性和抽样结果校验。

**Output**

- research workbook；
- analysis matrix；
- QA / validation inputs；
- codebook / method log。

因此，Layer 3 不是再做一次新的语言分析，而是把 L1 和 L2 已经得到的研究变量按 study schema 进行合并、校验和交付。

## 3. 当前实际情况

### 3.1 客户当前提供或承诺的内容

当前 C10 样例中已经有：

- 一个 verified speaker-attributed transcript TXT；
- annotation conventions guide（DOCX / PDF）；
- `S1:`、`S2:`、`S3:` 和 `Teacher:` 等 speaker labels；
- `[bc]`、`[x]`、fillers、repetitions、false starts 和 repairs 等转录标记。

客户邮件还说明：

- 该样例对应 `Multilogue04_C_Level30_D1G4_P025_corrected_6tier.TextGrid`；
- 如有需要，可以重新提供这一 corrected TextGrid；
- 其余 recordings 的 Golden TextGrid、transcript 和 definition sets 正在交付。

所以，当前 transcript 格式本身是可用的。样例 recording 进入完整 Layer 2 前，仍需把对应 Golden TextGrid 与 TXT 配对；其余 recordings 同样按一组 TextGrid + TXT 进入。

### 3.2 当前工程实际能力

L1a / L1b 已经具备真实处理和人工 review workflow。Layer 2 / Layer 3 当前主要还是 feasibility implementation：

- `scripts/l2/run-feasibility.mjs` 当前读取 AssemblyAI JSON 生成 pseudo-gold transcript，并非直接读取客户 verified TXT；
- `scripts/l2/feasibility-core.mjs` 中的 AS-unit、clause、MWU、repair、rate 和 lexical-tool definitions 仍明确标记为 simulated / fixture；
- word timing 目前来自未人工校验的 MFA 或 AssemblyAI fallback；
- Layer 2 feasibility 当前主要按 P025 计算，没有完整实现 Atlas 要求的 P025 / P035 双 threshold 传递；
- `scripts/l3/run-feasibility.mjs` 能生成 provisional matrix、codebook 和 provenance check，但当前矩阵临时按 participant/speaker rows 构造；
- 当前 L3 输出明确是 engineering feasibility，不是 final research release。

这说明主链路的骨架已经存在，但“客户真实输入适配、研究定义冻结、双 threshold 和最终 study schema”尚未完全替换 feasibility fixtures。

## 4. 系统预想与实际 Gap

| 范围 | Atlas 预想 | 当前实际 | Gap 如何补齐 |
|---|---|---|---|
| Recording 输入 | Golden L1b TextGrid + reviewed transcript + conventions | 已有 TXT 样例和 conventions；对应 Golden TextGrid 未在 C10 同包出现 | 将客户 corrected TextGrid 与同名 TXT 按 recording ID 配对；WAV 和 L1 session 直接复用系统已有资料 |
| Transcript ingestion | 直接处理 researcher-reviewed transcript | L2 feasibility 仍从 AssemblyAI JSON 构造 pseudo-gold | 后续让 L2 直接读取客户 TXT；AssemblyAI 只保留为 alignment/support evidence，不再作为 transcript truth |
| Speaker / annotation parsing | 保留 canonical speakers 和转录约定 | 当前客户 TXT 已含 `S1/S2/S3/Teacher`、`[bc]`、`[x]` 等 | 按 annotation guide 解析；Teacher 与 participant 指标分开；未知标记进入 unresolved report，不静默删除 |
| Word timing | lexical/MWU 与 pause-location 可关联到时间轴 | 客户 TXT 无 timestamps；Golden TextGrid 也不等于逐词时间 | 不要求客户补逐词时间。用 WAV + verified TXT 在系统内部生成 forced alignment，并对低置信度/关键样例做抽查；生成 timing 必须标记为 generated，不冒充 Gold |
| AS-unit / clause | 使用 research definitions 生成并 review units | 当前只是“一个 ASR utterance = 一个 AS-unit candidate”的 fixture | 采用明确、可引用、可版本化的 AS-unit / clause rule 作为 provisional 方法，并对 calibration sample 人工复核；客户 definition set 到达后做 rule diff 和重算 |
| MWU | 按研究定义、词表/频率/association rules 计算 | 当前只是小型 fixture target list 的 exact match | 冻结 provisional MWU operational definition、reference corpus、frequency/range/association settings；客户定义到达后替换配置并重算 MWU 模块 |
| TAALES / TAALED / AntConc | 版本和变量可复现 | 当前尚无已批准的 tool versions / selected variables | 我方可以先确定专业且可复现的版本与变量清单，并明确标为 provisional；这不要求客户必须额外制作配置文件，但最终应让客户确认方法 |
| Pause thresholds | P025 / P035 独立运行并在 Phase V 同时保留 | UI 中 0.25 / 0.35 为固定值；当前 L2/L3 feasibility 主要只传递 P025 | 固定的 0.25 / 0.35 本身不构成问题；需要让 Phase IV 对两个 threshold 分别生成结果，并在 Phase V 用 `threshold` 字段保留两组 observations。额外自定义 threshold 暂不需要实现 |
| Layer 2 handoff | Phase III–IV 形成 reviewed feature package | 当前已有 early handoff，但包含 simulated/generated provenance | 保留 provenance；真实 TXT、definitions 和 review 替换完成后，将对应字段从 provisional 升级为 accepted |
| Layer 3 observation grain | 由 study schema 决定 one row per observation | feasibility 暂时固定为 speaker-level rows | 不把临时 speaker-row 当最终规范。由 study schema 明确 observation grain；在未确认前，可先用 `participant × recording × threshold` 作为 provisional matrix，并在 codebook 标明 |
| Layer 3 release | workbook + matrix + QA + codebook | compiler 骨架已有，但 schema/codebook 是 provisional | 用真实 L2 handoff 编译 provisional workbook/matrix；客户确认 study schema、definitions 和校验样例后再形成 final release |

## 5. 最小补齐路径

### Step 1 — 先把客户输入配对完整

每个 recording 只建立以下输入关系：

```text
Existing WAV / L1 session
        +
Golden corrected L1b TextGrid
        +
Verified speaker-attributed transcript TXT
        +
One shared annotation / definition set
```

不要求客户额外提供逐词 timestamps，也不要求每个 recording 重复提交相同的工具配置。

### Step 2 — 按 Atlas 完成 Phase III

直接以客户 TXT 为 transcript truth，生成：

- per-speaker RAW / TIDY transcripts；
- turns / utterance units；
- AS-unit / clause map；
- unresolved / review items。

这一阶段基本不依赖 TAALES、TAALED、AntConc 或 MWU 统计规则，因此可以最先稳定下来。

### Step 3 — 用可替换的 provisional definitions 完成 Phase IV

在客户完整 definition set 到达前，我方可以先冻结一版最小研究配置：

- AS-unit / clause boundary rule；
- MWU operational definition；
- pause-location rule；
- rate numerator / denominator；
- TAALES / TAALED / AntConc versions and selected outputs；
- P025 / P035 的独立计算方式。

这套配置是**我们的专业暂定标准**，来源可以是公开研究定义和工具官方方法，但它不是“客户已经批准的标准”。所有受这些定义影响的字段统一标记为 provisional。

### Step 4 — 按 study schema 进入 Phase V / Layer 3

将以下内容合并：

- L1 nine-label totals；
- signed FTO；
- RAW / TIDY transcript references；
- AS-unit / clause measures；
- lexical / MWU measures；
- pause-location / rate measures；
- participant、task、group 等 study metadata；
- threshold 和 provenance。

生成：

- `research_export.xlsx`；
- `analysis_matrix.csv`；
- codebook；
- QA / validation report。

若最终 study schema 尚未确认，先生成 provisional matrix 供研究团队检查字段、粒度和样例值，不把它声明为 final。

### Step 5 — 客户 definitions 到达后只做差异重算

不需要推倒重来。对客户 definitions 与 provisional definitions 做逐项比较：

- transcript conventions 有变化：重跑 Phase III 及下游受影响部分；
- AS-unit / clause rules 有变化：重跑 unit、clause、pause-location、rate 及 Phase V merge；
- MWU / lexical settings 有变化：只重跑相应 feature modules 和 Phase V merge；
- study schema 有变化：主要重编 Phase V matrix / workbook；
- 没有变化的 L1 Gold evidence、TXT 和基础统计继续复用。

## 6. 谁需要补什么

### 客户侧真正需要提供

- 每个 recording 的 Golden corrected L1b TextGrid；
- 每个 recording 的 verified transcript TXT；
- 一份全局 annotation conventions / definition set；
- 现有项目资料无法推导时，补充 participant、task、group 等研究 metadata；
- 对最终 method choices 和 study schema 的确认；确认结论即可，不要求制作特定格式的新文件。

### 我方需要完成

- 让真实 TXT 成为 Layer 2 transcript input；
- 将 TextGrid、TXT、WAV 和 session 按 recording ID 绑定；
- 内部生成必要的 word alignment；
- 用版本化定义运行 AS-unit、MWU、lexical、pause 和 rate modules；
- 传递 P025 / P035 两套结果；
- 按 study schema 生成 Layer 3 workbook、matrix、codebook 和 QA；
- 对 provisional / accepted / final 状态做清楚标记。

## 7. 不应再增加的复杂度

以下内容可以作为内部审计信息，但不应提升为客户必须准备的新顶层输入：

- hashes、manifests、provenance logs；
- alignment diagnostics；
- unresolved item reports；
- 工具运行日志和缓存；
- 为中间计算使用的额外 TIDY 派生文本；
- feasibility 阶段的临时 CSV 文件。

它们服务于可追溯性和 QA，不改变 Methodology Atlas 的核心 I/O。

同样，不应把当前 feasibility implementation 的限制写成最终方法，例如：

- 不把 AssemblyAI pseudo-gold 当成客户 transcript；
- 不把 fixture MWU list 当成研究 MWU 定义；
- 不把“一个 ASR utterance 等于一个 AS-unit”当成正式规则；
- 不把 one-row-per-speaker 固定成最终 Layer 3 schema；
- 不把仅有 P025 的临时计算当成 Atlas 已完成。

## 8. 最终判断

`Golden L1b TextGrid + verified TXT` 足以作为客户侧每个 recording 的 Layer 2 核心输入。结合系统已有 WAV、L1 session 和一套明确标记的 provisional definitions，我们可以产生完整的 Layer 2 provisional output，并继续生成 Layer 3 provisional workbook / analysis matrix。

当前的主要工作不是向客户索要大量额外文件，而是：

1. 用客户真实 TXT 替换 pseudo-gold 输入；
2. 把方法定义从 fixture 升级为可版本化、可确认的 research configuration；
3. 把 P025 / P035 和正确的 study observation grain 贯穿到 Phase V；
4. 客户 definitions 到达后做差异重算和最终确认。

这与 Methodology Atlas 的原始流程是一致的，也是在不扩大客户负担的前提下，从当前工程实际补齐到研究交付的最短路径。

## 9. 依据位置

- Methodology Atlas：`html/MWU Pipeline.html`，Phase III–V；
- 当前 L2 feasibility runner：`scripts/l2/run-feasibility.mjs`；
- 当前 L2 simulated definitions：`scripts/l2/feasibility-core.mjs`；
- 当前 L3 feasibility compiler：`scripts/l3/run-feasibility.mjs`；
- 客户样例 transcript / convention documents：`C:\Users\yyang.DELOITTEML\Downloads\C10`。
