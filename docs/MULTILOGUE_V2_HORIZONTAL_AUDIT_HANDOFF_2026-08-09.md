# Multilogue v2 横向审计交接稿

更新时间：2026-08-09
仓库：MWU repository root
用途：交给独立 Agent 重新核查客户需求、算法、Gold 校准、测试证据和剩余风险。不要直接复述本文结论，应从列出的文件重新计算。

## 1. 项目背景

研究对象是多人 L2 英语对话中的流利度、停顿、轮次和词汇/MWU 使用。当前工程重点仍是 L1：先把可审阅的 speaker、pause、floor、transition 和九类时间轴草稿交给研究者，再由研究者在 Praat 中校正。自动输出不是最终研究数据。

早期方案主要输出 sounding/silence、speaker、transcript 和 review。客户后来提供了新的多人互动方法，要求系统输出：

- 三个固定说话人层 `S1/S2/S3`；
- 持续的 floor 状态；
- transition/FTO 证据；
- review flags；
- 九类互斥时间轴标签；
- R1-R5 floor 规则；
- Path B 作为当前 overlap 基线。

客户已经确认 Workflow Atlas 的整体结构、六层 TextGrid、九类标签及 R1-R5。客户另外确认 Path B 为基线，因为单房间混音不适合直接依赖自动 signed FTO。

## 2. 客户数据与保密边界

Multilogue 音频属于真实人类受试者研究数据，不得上传到未获允许的第三方、公开仓库或外部分析服务。当前客户已允许用 AssemblyAI 和 pyannoteAI 做本次技术测试，但审计 Agent 不得重新上传音频。

主要文件：

- 原始音频：`sample/Multilogue04_C_Level30 D1G4.wav`
- 客户完整 Gold：`outputs/multilogue-v2-poc/Multilogue04_C_Level30_D1G4_P025_corrected_6tier.TextGrid`
- Gold 时长：`501.013333` 秒
- 第二段音频：`sample/Multilogue01_C_Level15 D1G1.wav`
- 流程图：`html/MWU Pipeline.html`
- 需求：`specs/multilogue-v2/requirements.md`
- 设计：`specs/multilogue-v2/design.md`

不要在报告、日志或 CSV 中写 transcript 正文、API Key、signed URL 或受试者身份信息。

## 3. 当前固定方法

### 3.1 提供商与本地模块

| 模块 | 当前职责 |
|---|---|
| pyannoteAI | 主要 speaker diarization、speaker turn、overlap 证据、speaker-local muted-mirror 轨道 |
| AssemblyAI | verbatim transcript、word timing、disfluency、第二套 speaker 归属证据 |
| 本地 acoustic/VAD | speaker-conditioned 声学活动、边界候选、停顿拓扑；不得根据文字猜声学停顿 |
| Stage 1 fusion | 显式映射两家 provider speaker ID 到 `S1/S2/S3`，融合 timed words、turns、声学证据和不确定性 |
| Semantic lane | 根据 evidence role、R1-R5、backchannel/question 规则生成 floor、transitions 和标签语义 |
| Topology lane | 用声学证据改善 active/inactive 边界，但不得改变已冻结的 floor/transition 语义 |
| Composer | 组合 topology 与 semantics，保留 flags，并强制六层结构与 reciprocal `ol` |

原始 WAV 是唯一主时钟。provider duration 不能延长原始录音；越界区间必须裁剪或拒绝并记录。

### 3.2 六层 TextGrid

1. `S1` IntervalTier
2. `S2` IntervalTier
3. `S3` IntervalTier
4. `floor` IntervalTier：`S1/S2/S3/FREE`
5. `transitions` TextTier
6. `flags` IntervalTier

所有 IntervalTier 必须从 0 连续覆盖至 WAV 时长，不得存在 gap 或 overlap。`ol` 必须至少出现在两个 speaker tier 的同一时间段。

### 3.3 九类标签

| 标签 | 含义 |
|---|---|
| `s` | 当前 floor holder 的 lexical speech |
| `f` | floor holder 的 filled hesitation，例如 um/uh/er、延长元音 |
| `bc` | 非 holder 的短支持性反馈，不转移 floor |
| `ol` | 至少两名非纯 backchannel 说话人同时活动至少 100 ms；所有相关 speaker 必须互惠标记 |
| `op` | holder 沉默但保留 floor 的 own pause |
| `pf` | 非 holder 在他人持有 floor 时的 listening interval，不是个人犹豫停顿 |
| `tr` | floor FREE 且不超过 L，之后由另一 speaker 接管的 transition gap |
| `shs` | floor FREE 且无人说话超过 L，或直到任务结束的 shared silence |
| `x` | 咳嗽、处理噪音、无词笑声或不可用音频等正式标签；不确定性另写 Tier 6 flag |

默认 phonation 包含 `s/f/ol`，排除 `bc/op/pf/tr/shs/x`。

### 3.4 R1-R5

- R1：任务开始时 floor 为 `FREE`。
- R2：`FREE` 后第一个 turn-taking vocalisation 取得 floor。
- R3：holder 自身沉默或其他人合格 `bc` 不释放、不转移 floor。
- R4：非 holder 的真实 turn attempt 只有在 holder 结束后仍然持续时才转移 floor；失败 bid 不生成 FTO；多 speaker 竞争不明确时必须 flag，不能按 ID 或事件顺序猜赢家。
- R5：同一 holder 恢复时中间静默为 `op`；不同 speaker 在 L 内进入为 `tr`；超过 L 或任务结束仍无人恢复时，整段为 `shs`。

当前固定参数：

- `P=0.25s` 是本次 Gold 校准阈值；系统架构还支持独立的 `P=0.35s`。
- floor release `L=1.0s`。
- qualified overlap 最小值 `0.10s`。
- Path B：遇到 overlap transition 时保留起止时间和证据，但 `FTO=NA`，状态写 `overlap_present_offset_not_measured`；不能写 0 或伪造 signed FTO。

## 4. 客户提供的 Gold 与指摘

客户完整校正了 Multilogue04 的 501.013333 秒，保留六层结构，并校正：

- S1-S3 speech onset/offset，目标精度约为正负 10 ms；
- `f/bc/op/pf/ol`；
- floor；
- transitions 和 overlap flags。

客户特别指出两个错误：

1. 复杂区间约 42-46 秒：主讲者发言期间，两位 listener 发生重叠 `bc`；之后 S2 提问，S3 回答。原系统把问题和回答都归给 S3，漏掉 `S3 -> S2 -> S3` 的中间 floor handoff。
2. 录音尾部：两次短 listener `bc` 被错误标成 `tr`，但主讲者一直持有 floor。

## 5. 原始 v2.1 基线

原始候选：

`outputs/multilogue-v2-poc/Multilogue04_C_Level30_D1G4/phase-ii/P025/Multilogue04_C_Level30_D1G4.P025.draft.6tier.TextGrid`

全片指标：

| KPI | v2.1 |
|---|---:|
| active-set exact accuracy | 0.785012 |
| boundary F1 at 100 ms | 0.630483 |
| floor accuracy | 0.981449 |
| nine-label macro F1 | 0.667195 |
| `f` F1 | 0.254642 |
| `bc` F1 | 0.239465 |
| transition matched / Gold | 13 / 17 |
| transition precision | 0.764706 |
| transition FP / FN | 4 / 4 |
| Tier 5 handoff F1 at 100 ms | 0.619048 |

客户复杂窗口：没有恢复真实 handoff，floor accuracy 0.396174，`bc` F1 为 0。
客户尾部窗口：4 个错误 handoff，3.36 秒错误 `tr`，floor accuracy 0.824。

## 6. 校准过程

Gold 只允许评分器读取。候选生成器拒绝 `--gold`，manifest 必须记录 `runtime_gold_access=false`，候选索引和文件使用 SHA-256 防止生成后篡改。

主要里程碑：

- R10：建立 evidence role 和语义基线。
- R19：声学 topology/boundary 的当前主要来源。
- R20：第一次广泛保留 overlap residual，虽然 `bc` 提高，但破坏 transition 和 filler，因此拒绝。
- R24/R27：增加严格 identity tie、持续时间、覆盖率、speaker pair 和 provenance 条件；保留片段只能作为 reviewable `bc`，不能取得 floor，也不能倒推 floor 边界。
- R30：Gold 指标较好，但 blind replay 发现单侧 `ol`，TextGrid schema 不合法，因此不得冻结。
- R32：将保留证据固定为 `bc`，组合后自动降级所有剩余单侧 `ol` 并 flag；通过 schema，并接入正式 blind runner。

R32 的 overlap residual 条件：

- 事件必须是真正的 speaker identity tie；
- qualified provider overlap 必须包含候选 speaker 和造成 tie 的竞争 speaker；
- overlap 对残余事件覆盖率至少 80%；
- 事件最长 350 ms；
-只能影响 `bc` activity/review，不得形成或回溯 floor transfer。

注意：provider overlap 和 residual speaker turn 都来自 pyannote lineage，不应对外称为“两份独立证据”。本地声学支持是附加约束，不等于第二个 diarization Gold。

## 7. 当前最佳候选 R32

TextGrid：

`outputs/multilogue-v2-calibration/Multilogue04_C_Level30_D1G4/P025/v2.3za-r32-schema-valid-composition-20260809/candidates/candidates/r16-5a1550bf9eb3/Multilogue04_C_Level30_D1G4.P025.r16-5a1550bf9eb3.6tier.TextGrid`

正式评估：

- `outputs/multilogue-v2-calibration/Multilogue04_C_Level30_D1G4/P025/v2.3za-r32-schema-valid-composition-20260809/technical-assessment.json`
- `outputs/multilogue-v2-calibration/Multilogue04_C_Level30_D1G4/P025/v2.3za-r32-schema-valid-composition-20260809/technical-assessment.md`
- `outputs/multilogue-v2-calibration/Multilogue04_C_Level30_D1G4/P025/v2.3za-r32-schema-valid-composition-20260809/customer-edge-case-score.json`

### 7.1 全片结果

| KPI | v2.1 | R32 | 变化 |
|---|---:|---:|---:|
| active-set exact accuracy | 0.785012 | 0.858312 | +0.073300 |
| boundary F1 at 100 ms | 0.630483 | 0.741113 | +0.110630 |
| floor accuracy | 0.981449 | 0.989085 | +0.007636 |
| floor mismatch seconds | 9.294258 | 5.468407 | -3.825851 |
| nine-label macro F1 | 0.667195 | 0.722609 | +0.055414 |
| `f` F1 | 0.254642 | 0.363017 | +0.108375 |
| `bc` F1 | 0.239465 | 0.426515 | +0.187050 |
| transition matched / Gold | 13 / 17 | 15 / 17 | +2 |
| transition precision | 0.764706 | 0.625000 | -0.139706 |
| transition FP / FN | 4 / 4 | 9 / 2 | FP +5，FN -2 |
| Tier 5 handoff F1 at 100 ms | 0.619048 | 0.750000 | +0.130952 |

不要只报提升：R32 找到更多真实 transition，但全片 transition FP 从 4 增加到 9，precision 从 0.764706 降到 0.625。这是当前主要回归。

正式 8 项 Gate 通过 7 项。未通过项是 boundary F1@100ms：实际 0.741113，目标 0.75，差 0.008887。

### 7.2 客户点名窗口

复杂 overlap/question/answer，41.5-47 秒：

- floor accuracy：0.396174 -> 0.984532；
- `tr` interval F1：0 -> 0.914670；
- 真实 `S3 -> S2 -> S3` 两次 handoff 已恢复；
- 第二次 S2->S3 边界误差约 2 ms；第一次 outgoing end 约差 79 ms，incoming start 约差 3 ms；
- `bc` 仍只部分恢复：R32 只保留 S2 的 42.02-42.37，Gold 的 S2 是 42.324312-42.600509；Gold 的 S1 42.015764-42.600509 在 runtime input 中没有可靠 speaker evidence；
- 该窗口 `bc` F1 仅 0.075459，不能称为解决。

尾部 spurious transitions，485-495 秒：

- floor accuracy：0.824 -> 1.0；
- 错误 `tr`：3.36 秒 -> 0；
- 错误 handoff：4 -> 0；
- `bc` F1：0 -> 0.467851；
- 可以描述为“在 Multilogue04 Gold 上收敛”，不能外推为所有录音都已解决。

## 8. 测试与完整性证据

- 测试命令：`node tests/multilogue-v2-calibration/run-tests.mjs`
- 当前结果：56 passed，0 failed。
- 报告：`tests/multilogue-v2-calibration/artifacts/test-report.json`
- 包含客户两个 edge case 的 synthetic regression。
- R32 六层 TextGrid schema validation：通过，0 error。
- reciprocal `ol`：通过。
- Tier 5 internal consistency：通过。
- 正式 blind runner 用 Multilogue04 cached inputs 重放后，与 R32 TextGrid 字节级相同。
- 两份 TextGrid SHA-256：`2e1a1810306dfce0a09d0dc6bfe9d0f75a9cf0fb53d5892c9fb13ab0b24ecd3f`。

正式 replay：

`outputs/multilogue-v2-calibration/Multilogue04_C_Level30_D1G4/P025/blind-runner-r32-replay-v3-20260809/`

## 9. 第二样本状态

Multilogue01 的 AssemblyAI 已成功：

- status `completed`；
- 3 speakers；
- 15 utterances；
- 830 words；
- transcript confidence 约 0.9184。

pyannoteAI 的 Key 存在且认证成功，media create 和 upload 都成功，但提交 diarization job 时返回：

`HTTP 402: Insufficient credits and no active subscription.`

这不是 Key 缺失。当前 `.env` 同时存在 `ASSEMBLYAI_API_KEY` 和 `PYANNOTE_API_KEY`，但 pyannoteAI 账户没有可用额度/订阅。`HF_TOKEN/HUGGINGFACE_TOKEN` 未配置，因此本地 Pyannote 也不能作为当前替代。

Multilogue01 已完成 R32 单提供商结构 smoke test：schema 和 Tier 5 通过，但状态必须保持：

`degraded_smoke_test_not_for_researcher_scoring`

路径：

`outputs/multilogue-v2-blind/Multilogue01_C_Level15_D1G1/degraded-single-provider-smoke/r32-runner-smoke-20260809/`

它不能证明跨录音 accuracy，也不能用于冻结 R32。

## 10. 当前结论

- R32 是 Multilogue04 Gold 上的最佳 schema-valid calibrated candidate。
- 它已进入正式 blind runner，不是只存在于 Gold 评分脚本中的特殊版本。
- 尾部虚假 transition 在校准录音上已解决。
- 复杂问题/回答的 speaker attribution 和 floor handoff 基本恢复。
- 复杂 simultaneous `bc` 仍只有部分恢复，尤其 S1 feedback 没有 runtime evidence。
- 全片 transition false positives 增加，仍需研究者 review。
- R32 不是 frozen baseline，也不能宣称 90% overall accuracy。
- 冻结条件：在另一段未参与调参的 multilogue 上，用同一固定双提供商配置生成草稿，再由研究者完整校正并按相同 KPI 评分。

## 11. 横向审计任务

请独立回答以下问题，并给出文件/行号或重算结果：

1. Workflow Atlas、requirements、design、客户 Gold 的九标签/R1-R5/Path B 是否一致。
2. Gold 是否只进入 scorer/assessment，是否存在 generator runtime Gold leakage、Gold 时间戳硬编码或 speaker-specific rule。
3. R32 与 v2.1 的指标能否从 TextGrid 独立复算一致。
4. transition matched/FP/FN、Tier 5 handoff 和 floor-derived handoff 是否采用一致定义；Gold Tier 5 中的旧点是否会污染评分。
5. R32 的 overlap residual 规则是否通用，是否存在对 Multilogue04 过拟合。
6. `qualified provider overlap` 与 residual 的证据 lineage 是否被错误描述为独立证据。
7. 复杂窗口为什么仍漏 S1 `bc`；在不虚构 speaker evidence 的前提下是否存在更稳妥的方案。
8. transition FP 从 4 增至 9 是否足以否决 R32，或应采用多目标选择策略。
9. composer 的单侧 `ol` 修复是否符合九标签定义，是否可能把真实 overlap 错降为 `bc`。
10. 56 个测试是否覆盖真实集成路径，还是主要为 synthetic/unit；还缺哪些 adversarial、property-based、cross-recording tests。
11. Multilogue01 单提供商 smoke test 是否被任何文档误写为 blind accuracy validation。
12. 当前是否具备对客户声称“方案已冻结、跨样本有效、研究可直接使用”的证据。预期答案应为否，除非审计找到新的第二 Gold 证据。

## 12. 建议复现命令

在仓库根目录运行：

```bash
node tests/multilogue-v2-calibration/run-tests.mjs

node scripts/multilogue-v2/calibration/score-customer-edge-cases.mjs \
  --candidate-score outputs/multilogue-v2-calibration/Multilogue04_C_Level30_D1G4/P025/v2.3za-r32-schema-valid-composition-20260809/score.json \
  --output /tmp/multilogue-r32-edge-score.json

node scripts/multilogue-v2/calibration/build-r32-technical-assessment.mjs
```

不要重新运行任何 provider 上传命令。必要时只读取现有 cached provider JSON。

## 13. 仓库状态提醒

当前 worktree 不是干净发布分支：`scripts/multilogue-v2/`、`specs/multilogue-v2/`、相关 tests/outputs 中有未跟踪或未提交内容，另外还有与本次审计无关的 UI/validation 改动。审计时不要执行 `git reset --hard`、`git clean` 或覆盖现有输出。先记录 `git status --short`，再只读审计。
