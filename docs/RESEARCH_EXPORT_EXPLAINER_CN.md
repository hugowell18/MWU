# Research Export 说明

这份文档解释 `reviewed.research_export.xlsx` 的意义、每个 sheet 的用途、每列是什么意思，以及它如何对齐 Jon 邮件里的研究需求。

## 1. 这份 Excel 的意义

之前的 demo 只证明了一件事：

```text
audio -> 6-tier TextGrid -> Praat 人工确认 -> 导出 Timeline Excel
```

这只能回答基础问题：

- 哪些时间是 sounding？
- 哪些时间是 silence？
- 谁在说？
- 对应 transcript 是什么？

但 Jon 邮件里真正强调的是更进一步的研究问题：

- pause 不只是多长，还要知道 pause 出现在什么位置；
- pause location 需要区分 mid-clause、end-clause、turn boundary；
- pause 和 MWU / multi-word units 的关系也很重要；
- 这些判断不能只靠 utterance-level transcript，必须有 word-level timing；
- word-level timing 应该来自 reviewed transcript + forced alignment，而不是未校正 ASR 时间戳。

所以新的 research export 不是普通 Excel，而是把流程往 Jon 要的研究分析方向推进：

```text
reviewed TextGrid
-> extract 250ms silent pauses
-> run MFA on reviewed transcript
-> get word-level timing
-> connect pauses with previous/next words
-> export Timeline + Pauses + Summary
```

当前这一步还没有最终判断 MWU，也没有最终判断 mid-clause / end-clause。它的作用是把“能算的”和“还需要研究者定义/校验的”分开，避免假装系统已经知道 clause/MWU。

## 2. Workbook 结构

当前研究导出文件是：

```text
outputs/textgrid-export/elllo_425_dinner_plans.reviewed.research_export.xlsx
```

它有 3 个 sheet：

| Sheet | 用途 | 对应研究问题 |
|---|---|---|
| `Timeline` | 从 reviewed TextGrid 导出的完整 sounding/silence 时间线 | 基础 fluency：sounding、silence、duration、speaker、transcript |
| `Pauses` | 只列出达到阈值的 silent pauses，并连接 word alignment | Jon 要的 pause location / pause-MWU 分析前置数据 |
| `Summary` | 汇总本文件的关键统计和方法参数 | 方法披露、验证、复现 |

## 3. Timeline sheet

`Timeline` 的核心来源是 reviewed TextGrid 的最终研究层：

- Tier 1：`praat_sounding_silence`
- Tier 4：`speaker`
- Tier 5：`transcript`

也就是说，`Timeline` 不再使用 AssemblyAI JSON 作为最终数据源。

### Timeline columns

| Column | 意思 | 为什么需要 |
|---|---|---|
| `segment_id` | 导出时生成的时间段编号 | 方便追踪每一行 |
| `segment_type` | `sounding` 或 `silence` | fluency 最基础的声学分类 |
| `praat_ref_label` | reviewed Tier 1 的标签 | 说明该行来自 Praat reviewed acoustic tier |
| `local_vad_ref_label` | draft 阶段 local VAD 标签；reviewed 模式下通常为空 | 自动参考层，不作为最终研究数据 |
| `sounding_silence_review_status` | draft 阶段 T3 冲突标记；reviewed 模式下通常为空 | 审计痕迹，不作为最终统计主线 |
| `start_time` | 时间段开始，`mm:ss.xx` | 人读友好 |
| `end_time` | 时间段结束，`mm:ss.xx` | 人读友好 |
| `duration_seconds` | 持续时间，秒 | 后续统计使用，保留数值 |
| `speaker` | 该段对应说话人 | 分人统计 fluency/vocabulary |
| `utterance_id` | transcript 的 turn 编号 | 把 timeline 和 transcript 连接起来 |
| `transcript` | 该时间段对应文本 | vocabulary / MWU 分析的文本基础 |
| `review_status` | reviewed TextGrid 中 T6 的状态 | 说明是否人工确认/修正 |
| `review_state` | `fixed` / `confirmed` / `n/a` 等结构化状态 | 方便筛选 |
| `review_detail` | review 状态详情 | 审计说明 |
| `review_required` | 是否还需要检查 | reviewed 后理论上应为 false |
| `human_reviewed` | 是否来自人工确认状态 | 区分 draft 和 reviewed |
| `include_in_research` | 是否纳入研究统计 | 允许排除坏段 |
| `word_count` | 当前 transcript 的词数 | speech rate / vocabulary 统计的粗粒度基础 |
| `source_textgrid` | 来源 TextGrid 文件名 | 可追溯 |

### Timeline 的设计理由

`Timeline` 回答的是基础 fluency 问题：

- 总 sounding 时间是多少？
- 总 silence 时间是多少？
- 每个 speaker 的说话时间和文本是什么？
- pause/silence 是否保留？

它不是用来最终判断 pause location 的，因为它只有 utterance-level transcript，没有 word-level timing。

## 4. Pauses sheet

`Pauses` 是这次往 Jon 邮件方向推进的关键。

它只列出满足阈值的 silent pauses。当前默认阈值是：

```text
silent pause >= 0.25 seconds
```

这对应 Jon 邮件里提到的 silent-pause threshold 需要显式记录。

### Pauses columns

| Column | 意思 | 为什么需要 |
|---|---|---|
| `pause_id` | pause 编号 | 每个 pause 可单独引用 |
| `start_sec` | pause 开始时间，秒 | 研究计算用 |
| `end_sec` | pause 结束时间，秒 | 研究计算用 |
| `duration_sec` | pause 时长，秒 | breakdown fluency 核心指标 |
| `threshold_sec` | 当前采用的 pause 阈值 | 方法可复现；目前是 0.25 |
| `speaker_context` | pause 与 speaker/utterance 的关系 | 判断 turn boundary / same-speaker gap |
| `pause_location_candidate` | 系统当前能给出的 pause location 候选 | 不是最终结论，是候选标签 |
| `location_confidence` | 当前候选可信度 | 避免把低置信判断当成真值 |
| `needs_word_alignment` | 是否还缺 word-level timing | 告诉我们是否必须跑 MFA |
| `needs_clause_boundary` | 是否还缺 clause boundary | 判断 mid-clause/end-clause 必需 |
| `previous_utterance_id` | pause 前一个 utterance | 提供上下文 |
| `previous_speaker` | pause 前一个 speaker | 判断 speaker change |
| `previous_text` | pause 前一个 utterance 文本 | 人工检查用 |
| `next_utterance_id` | pause 后一个 utterance | 提供上下文 |
| `next_speaker` | pause 后一个 speaker | 判断 speaker change |
| `next_text` | pause 后一个 utterance 文本 | 人工检查用 |
| `containing_utterance_id` | pause 完全落在哪个 utterance 内 | 判断 intra-utterance pause |
| `containing_speaker` | containing utterance 的 speaker | 分人分析 |
| `containing_text` | containing utterance 文本 | 人工检查用 |
| `overlapping_utterance_id` | pause 与哪个 utterance 部分重叠 | 处理边界不完全对齐情况 |
| `overlapping_speaker` | overlap utterance 的 speaker | 边界检查 |
| `overlapping_text` | overlap utterance 文本 | 边界检查 |
| `previous_word` | MFA 找到的 pause 前一个词 | Jon 要的 word-level timing 证据 |
| `next_word` | MFA 找到的 pause 后一个词 | 判断 pause 位于哪些词之间 |
| `word_timing_source` | word timing 来源 | 当前是 `forced_alignment` |
| `notes` | 系统解释为什么这样标记 | 方便研究者理解和复核 |

### pause_location_candidate 的含义

| 值 | 意思 | 当前能不能当最终结论 |
|---|---|---|
| `word_gap_requires_clause_boundary` | pause 已经能定位到两个 word 之间，但还不知道 clause boundary | 不能，需要 clause boundary |
| `turn_boundary_by_word_alignment` | MFA 显示 pause 落在不同 turn/speaker 的词之间 | 可以作为 turn-boundary candidate，但仍建议抽检 |
| `utterance_edge_overlap_requires_word_alignment` | pause 和 utterance 边界有重叠/错位 | 不能，需要人工或更细对齐检查 |
| `intra_utterance_requires_word_alignment` | pause 在 utterance 内，但还没有 word timing | 不能，需要 MFA |
| `utterance_boundary_requires_word_alignment` | pause 接近 utterance 边界，但没有 word timing | 不能，需要 MFA |

当前样例在跑完 MFA 后的结果：

| 指标 | 数值 |
|---|---:|
| pause count | 35 |
| total pause duration | 20.792 秒 |
| word alignment present | true |
| `word_gap_requires_clause_boundary` | 26 |
| `turn_boundary_by_word_alignment` | 7 |
| still needs word alignment | 2 |
| needs clause boundary | 35 |

这说明：MFA 已经解决了“pause 在哪些词之间”的问题，但还没有解决“这些词属于同一个 clause 还是不同 clause”的问题。

## 5. Summary sheet

`Summary` 是方法和质量摘要。

### Summary fields

| Field | 意思 |
|---|---|
| `Source TextGrid` | 使用哪份 reviewed TextGrid |
| `Generated At` | 导出时间 |
| `Timeline Segments` | Timeline 总行数 |
| `Sounding Segments` | sounding 段数 |
| `Silence Segments` | silence 段数 |
| `Sounding Duration` | 总 sounding 时间 |
| `Silence Duration` | 总 silence 时间 |
| `Timeline Pending Review Segments` | 仍需确认的 Timeline 段数，reviewed 后应为 0 |
| `Pause Segments JSON` | Pauses sheet 的来源 JSON |
| `Silent Pause Threshold` | 当前 pause 阈值 |
| `Pause Count` | 符合阈值的 silent pauses 数量 |
| `Total Pause Duration` | 符合阈值的 pause 总时长 |
| `Word Alignment Present` | 是否已经接入 word-level timing |
| `Needs Word Alignment` | 仍缺 word timing 的 pause 数 |
| `Needs Clause Boundary` | 仍缺 clause boundary 的 pause 数 |
| `Utterances` | reviewed transcript turn 数 |
| `Fixed / Confirmed / Pending` | review 状态统计 |
| `Speaker` | 每个 speaker 的 utterance 数 |

## 6. 为什么这么设计

### 6.1 不把 ASR 时间戳当最终研究数据

Jon 邮件强调 validated word-level timing。  
所以最终路径是：

```text
reviewed transcript + audio -> MFA -> word alignment
```

而不是：

```text
AssemblyAI word timestamps -> final pause analysis
```

### 6.2 不假装已经解决 clause/MWU

现在系统能做到：

- 从 reviewed Tier 1 取 pause；
- 从 MFA 取 previous/next word；
- 说明 pause 在哪些词之间；
- 标记是否还需要 clause boundary；
- 为 MWU-pause relation 留出接口。

但系统现在不能自动决定：

- 什么算 clause；
- 什么算 MWU；
- pause 是 mid-clause 还是 end-clause；
- pause 是 inside / before / after MWU。

这些需要研究者提供 operational definition，或者提供一批人工标注数据。

### 6.3 把“下一步缺什么”显式写进数据

`needs_word_alignment` 和 `needs_clause_boundary` 的目的，就是防止系统把不确定的东西包装成确定结果。

这比直接输出一个看似完整的 `pause_location = mid_clause` 更符合学术要求。

## 7. 怎么对齐 Jon 的需求

| Jon 邮件里的需求 | 当前实现怎么回应 |
|---|---|
| 最终数据基于 Praat reviewed TextGrid | `Timeline` 从 reviewed T1/T4/T5 导出 |
| silent pause threshold 要明确 | `Pauses.threshold_sec` 和 `Summary.Silent Pause Threshold` 记录 0.25 |
| pause location 重要 | 新增 `Pauses` sheet，列出每个 pause 的 location candidate |
| pause location 依赖 word/clause boundaries | `previous_word` / `next_word` 来自 MFA；`needs_clause_boundary` 明确标出 |
| word-level timing 不能留到很后面 | 已经从 reviewed transcript 跑 MFA，生成 `word_alignment.json` |
| MWU-pause relation 是核心分析 | 当前已经准备好 pause + word timing；下一步接 MWU tagging |
| 方法需要可验证 | `Summary` 记录来源、阈值、alignment 是否存在、仍需人工定义的部分 |

## 8. 下一步真正要做什么

下一步不是 WebUI，也不是继续美化 Excel。

下一步是让研究者确认两个方法学定义：

1. Clause boundary 怎么标？
   - 人工标？
   - 规则初稿 + 人工确认？
   - 是否按 punctuation / intonation / syntax？

2. MWU 怎么定义？
   - 给定 MWU list？
   - corpus-based n-gram？
   - researcher-reviewed candidates？

拿到这两个定义后，工程上才能继续：

```text
word_alignment.json
+ clause boundary definition
+ MWU definition
-> clause sheet
-> MWU sheet
-> pause-MWU relation sheet
-> validation report
```

这才是从 demo 进入 Jon 所说研究分析的下一阶段。
