我同意你的方向，而且我觉得这是目前最稳的推进方式：**按 Chris 的 5 个 Phase 一个一个拆 spec，再从 spec 推到 system design、task breakdown、报价。**

但我建议不要直接从 Phase I 开始写开发任务，而是先做一个三层结构：

**第一层：全局需求框架**
先统一所有 phase 共用的规则：

- 文件命名规范：`{Year}_{CourseCode}_{AssignmentID}_{GroupID}_{StudentHash/SpeakerID}`
- 输入输出目录结构
- 每个 phase 独立一键执行
- 每个 phase 执行后暂停，允许人工检查
- 每个 phase 都要有 validation/gold-standard sample
- 日志、参数、版本、处理记录要保存，方便论文复现
- 最终输出要服务 R/Python 统计分析

**第二层：逐 Phase 写 Spec**
每个 Phase 都用同一个模板整理：

- Phase objective：这个阶段解决什么研究问题
- Input：需要什么输入文件
- Output：产出什么文件
- Processing logic：核心处理逻辑
- Tools/libraries：可能用什么工具
- Configurable parameters：哪些参数要可配置
- Manual validation point：Chris 在哪里检查
- Acceptance criteria：怎么判断这个阶段做对了
- Open questions：需要 Chris 澄清什么
- Risk level：技术风险/研究风险/报价风险

这样 Chris 的需求会非常清楚，也方便我们后面报价。

**第三层：Design + Task Breakdown**
等 spec 清楚后，再进入：

- 系统架构设计
- 数据库/文件结构设计
- TextGrid schema 设计
- Web UI 页面设计
- 后端任务队列设计
- 每个 phase 的开发任务拆分
- MVP 范围和非 MVP 范围
- 报价阶段划分

我建议接下来这样排：

1. **先做 Phase I spec**
这是新增最大差异点：speaker diarization + muted mirror extraction。这个阶段决定后面所有数据是否可靠，风险最高。

2. **再做 Phase II spec**
这是 Praat 核心自动化：0.25/0.35 双阈值、Scale times、sounding/silent/invalid、segment duration metrics。它是 MVP 的主干。

3. **然后做 Phase III spec**
Transcript 拆分、RAW/TIDY 两套文本、word cleansing 规则，这里要明确他是否已有 master transcript。

4. **Phase IV spec**
TAALES/TAALED/AntConc 外部工具自动化。这里要单独评估工具安装、命令行能力、输出格式解析。

5. **Phase V spec**
最终数据库、AS-Unit pause mapping、统计矩阵。这一步依赖前面所有结构，所以最后梳理更合理。

我对报价阶段的建议还是保留我们的商业三阶段，但映射到 Chris 的五个研究 Phase：

| 报价阶段 | 覆盖 Chris Phase | 目的 |
|---|---|---|
| Stage 1 / MVP | Phase I + Phase II | 先打通音频、说话人分离、Praat/TextGrid、pause metrics |
| Stage 2 | Phase III + Phase IV | 加入 transcript 清洗、语言学工具批处理、成绩数据合并 |
| Stage 3 | Phase V + validation/reporting/UI polish | 最终统计矩阵、AS-Unit mapping、可靠性验证和完整系统化 |

这个方式比较好解释：**Chris 的 5 phase 是研究流程，我们的 3 stage 是交付和报价方式。**

另外，之前的 **6-tier MVP** 不需要废掉。它可以变成我们的内部 master annotation schema。对外则按 Chris 要求输出：

- Phase I 的 3-speaker TextGrid
- Phase II 的 threshold-specific TextGrid
- Phase V 的 AS-Unit mapping matrix

所以不是“6 tier 错了”，而是它应该从“客户可见 MVP 结构”调整为“系统内部统一数据模型”。

我的建议是：下一步先产出一份 **Requirement Spec v1**，按 Chris 的五个 Phase 拆开，同时加一章“与原 3-stage / 6-tier MVP 的差异”。这份文档完成后，再基于它做技术设计和报价，会稳很多。



我同意：先定整体架构，再拆每个 Phase 的 spec。调研后我的判断是：

**总体建议**
用 **Web UI + 后端任务队列 + 工具适配器** 的架构。AssemblyAI 可以作为 MVP 的默认 ASR/diarization API，但系统必须保留可替换接口，因为论文复现和数据隐私可能要求改用本地开源工具，如 pyannote/WhisperX。

核心原则：

- Web UI 只负责上传、配置、运行、校验、下载。
- 每个 Chris Phase 是一个独立模块，有自己的 Run 按钮。
- 后端保存每次运行的参数、工具版本、输入输出和日志。
- AssemblyAI/pyannote/Praat/TAALES/TAALED/AntConc 都通过 adapter 接入。
- 不做一个黑盒一键到底 pipeline。

**工具 API / 自动化可行性**
| 工具 | 是否适合后端自动化 | 判断 |
|---|---:|---|
| AssemblyAI | 高 | 有 API，支持 speaker diarization、`speakers_expected`、utterance/word timestamp、confidence；也支持保留 filler words。适合作为 MVP 的 Phase I/III 初始引擎。见 [AssemblyAI diarization docs](https://www.assemblyai.com/docs/pre-recorded-audio/label-speakers) 和 [filler words docs](https://www.assemblyai.com/docs/pre-recorded-audio/include-filler-words)。 |
| pyannote.audio | 高 | 本地 Python 库，可指定 `num_speakers`，适合论文复现或隐私要求更高的版本。见 [pyannote model docs](https://huggingface.co/pyannote/speaker-diarization-3.1)。 |
| WhisperX | 中高 | 本地工具，支持 ASR、word-level timestamps、speaker diarization。适合替代 AssemblyAI，但部署复杂度更高，最好有 GPU。见 [WhisperX GitHub](https://github.com/m-bain/whisperX)。 |
| Praat | 高 | 没有 REST API，但可以命令行 `--run` 执行脚本，非常适合后端自动化。注意脚本不能依赖打开编辑窗口的 GUI 命令。见 [Praat command line scripting](https://www.fon.hum.uva.nl/praat/manual/Scripting_6_9__Calling_from_the_command_line.html)。 |
| praatio | 高 | Python 库，可读写 Praat TextGrid，适合生成 Phase I/II/V 的 TextGrid。见 [praatio docs](https://timmahrt.github.io/praatIO/)。 |
| TAALES | 中 | 官方说明支持批量处理文件夹并输出 CSV，但不是现代 API。可以本地包装调用，需先验证命令行/批处理方式。见 [TAALES 官方页](https://www.linguisticanalysistools.org/taales.html)。 |
| TAALED | 中高 | 有 Python 版本/源码，可本地集成，适合后端调用。见 [TAALED 官方页](https://www.linguisticanalysistools.org/taaled.html)。 |
| AntConc | 低到中 | 官方定位是桌面软件，页面明确说只能跑在 desktop computers。命令行更多是启动程序，不是稳定 headless API。建议 MVP 中自己实现 4-word lexical bundles，再用 AntConc 做人工对照验证。见 [AntConc 官方页](https://www.laurenceanthony.net/software/antconc/)。 |
| MFA | 可选 | 如果后面需要更严格的 transcript-audio forced alignment，可用 Montreal Forced Aligner，CLI 友好且能输出 TextGrid。见 [MFA docs](https://montreal-forced-aligner.readthedocs.io/en/latest/user_guide/corpus_structure.html)。 |

**推荐整体架构**
```text
Web UI
  - Project dashboard
  - Phase I-V run buttons
  - Config panel
  - Validation/review screen
  - Artifact downloads

Backend API
  - Project/file metadata
  - Phase orchestration
  - Run history
  - Parameter/version logging

Job Queue / Workers
  - Audio worker
  - Diarization/ASR worker
  - Praat worker
  - Text-processing worker
  - Linguistic-tool worker
  - Matrix compiler worker

Storage
  - Original audio
  - Muted mirror speaker WAVs
  - TextGrid files
  - transcripts
  - CSV/XLSX outputs
  - logs/config snapshots
```

**按 Chris Phase 映射**
Phase I：建议 MVP 用 AssemblyAI 或 pyannote 做 diarization。AssemblyAI 能给 speaker labels、utterance/word timestamps；但 muted mirror audio 和 TextGrid 需要我们自己生成。

Phase II：必须以 Praat 为核心。后端调用 Praat script，跑 0.25/0.35 两套阈值，生成 `sounding/silent/invalid` TextGrid 和 metrics。

Phase III：如果 Chris 已有 master transcript，就以上传 transcript 为主；AssemblyAI 只作为辅助转写。系统生成 `_RAW-TIMING.txt` 和 `_TIDY-PHRASE.txt`。

Phase IV：TAALES/TAALED 本地批处理；AntConc 自动化风险较高，建议我们先实现等价 4-word bundle extractor，保留 AntConc 对照验证。

Phase V：我们自己写 Python matrix compiler，读取 TextGrid、pause metrics、AS-unit annotation、Phase IV 输出和成绩库，生成最终 R/Python wide matrix。

**关键设计决策**
我建议 MVP 先采用：

- AssemblyAI API 作为默认转写/说话人识别引擎。
- Praat CLI 作为正式 pause/duration analysis 引擎。
- praatio 作为 TextGrid 生成和解析层。
- Python 自研 audio/text/matrix 编译逻辑。
- pyannote/WhisperX 作为可替换本地引擎，不放在第一版必须交付里。
- AntConc 先不强行 headless 自动化，避免卡在 GUI 工具上。

下一步可以开始写 **System Architecture v1**，然后按 Phase I 到 Phase V 写 spec。第一份 spec 里重点先定：文件结构、artifact schema、每个 phase 的 input/output、工具 adapter、validation checkpoint。