# 文献对照表 — Literature Comparison

> 项目：L2 会话流畅性 × 多词单元(MWU/词块) 研究 · "AI起草 + Praat人工复核" 6层TextGrid工作流
> 整理日期：2026-06-15 · 共 15 篇（9 篇核心研究 + 3 篇补充 + 3 份项目自有计划）
>
> 三列含义：
> - **① 论文具体讲了什么**：研究问题、数据/方法、主要发现。
> - **② 与本项目的对比**：与我们(3人对话、6层工作流、MWU×流畅性)的异同、契合点与冲突点。
> - **③ 参考价值**：可直接落地的参数、定义、方法论、对工作流/Excel的启示。

---

## 第一组：流畅性理论与测量基石

### 1. Peltonen (2024) — *Fluency Revisited* (ELT Journal, 概念短文)

| ① 论文讲了什么 | ② 与本项目的对比 | ③ 参考价值 |
|---|---|---|
| 概念综述（非实证）。确立三套框架：Lennon 宽/窄义流畅性；Segalowitz 三元(utterance/cognitive/perceived)；**Skehan 三维度 speed/breakdown/repair**。提出三个新趋势：交互流畅性、流畅-不流畅连续体、L1说话风格影响。 | 我们做的是 **utterance fluency**。论文明确警告：流畅性是**交互/协作**活动，传统独白指标不能直接套用到对话数据——与我们3人对话场景高度相关。 | 无具体数字参数（理论锚点）。①用 speed/breakdown/repair 作为 Excel 指标上位分类；②支撑区分 mid/end-clause 停顿（窄义=少mid-clause停顿）；③支撑保留填充词/重复（disfluency 可为策略资源）；④**必须能测轮间静音(between-turn silence)**，区分 turn内停顿 vs 轮换间隙。 |

### 2. de Jong et al. (2012) — *Facets of Speaking Proficiency* (SSLA)

| ① 论文讲了什么 | ② 与本项目的对比 | ③ 参考价值 |
|---|---|---|
| 口语能力是否"成分性"。181名荷兰语L2学习者，用SEM。发现**词汇知识+语调(intonation)两项即解释75.3%方差**；支持"知识+加工"双成分模型。 | ⚠️ **这篇不是我们要的流畅性参数来源**。它是"能力成分"篇，不是"流畅性"篇。我们数据是对话独白混合，方法论原则可借，参数不在此。 | **重要缺口提醒**：250ms阈值、mid/end-clause 在其**姊妹篇 *Facets of Fluency***；音节率公式在 **de Jong & Wempe (2009)**。**两篇都不在当前 docs，建议向 Chris 索取**。本篇可借：①"自变量与因变量分开测量"避免循环论证；②指标按语量归一化；③对齐/VAD 用高采样率(≥16kHz)。 |

### 3. Tavakoli & Wright (2020) — *Second Language Speech Fluency* (Cambridge 专著) ⭐

| ① 论文讲了什么 | ② 与本项目的对比 | ③ 参考价值（参数最密集） |
|---|---|---|
| 流畅性研究到实践整合专著。第3章为测量"技术核心"。系统梳理流畅性概念分层、纯/复合指标、停顿位置、对话流畅性、MWU机制。 | 第3章§3.4 专论对话流畅性，直接关乎我们3人对话；§2.5 论 MWU↔流畅性，是我们核心论点基石。是与本项目最对口的总览文献。 | **停顿阈值演变**：1.0s→0.4/0.5s→**当前主流0.25s**(de Jong&Bosker 2013)→背书PI的250ms。**完整指标公式**：speech rate=音节/总时长；**articulation rate=音节/发声时长(纯速度,务必纳入)**；MLR；phonation time ratio；mean length of pause(按mid/end×silent/filled分算)。**用音节非词**。停顿位置↔Levelt(end=概念化/自然, mid=构造/困难)，子句切分用**AS-Unit**。**对话三大必答决策**：overlap怎么切、between-turn pause归谁、backchannel算不算新话轮。MWU机制(Götz 2013)："预制单元越多→停顿犹豫越少"。 |

---

## 第二组：MWU / 词块（项目核心理论来源）

### 4. Tavakoli & Uchihara (2020) — MWS 与口语流畅性 (Language Learning) ⭐

| ① 论文讲了什么 | ② 与本项目的对比 | ③ 参考价值 |
|---|---|---|
| 56名考生(3分钟**独白**)，问 n-gram 衡量的MWS是否关联水平与流畅性三维度。发现：高频n-gram↑→发音速率↑、mid-clause停顿↓；高MI→修补↓但end-clause停顿↑；**MI反随水平下降**(低水平反复用 I think 类高MI短语)。 | 独白 vs 我们对话；3分钟 vs 我们10分钟。MWS提取与流畅性关联框架可直接借用，但需注意对话中"任务/话题借用短语"干扰更强。 | **停顿阈值250ms**(引de Jong&Bosker 2013)。**MWS提取**：频率法+**TAALES+COCA口语子库**，bigram+trigram；8指标(proportion前30k/对数freq/t-score/MI)。流畅性三指标各取一：articulation rate / silent pause freq(分mid/end) / total repairs。**双文本要求**：流畅性用unpruned，MWS用清洗版。警示：单独标记任务借用短语。 |

### 5. Hougham, Clenton & Uchihara (2024) — 短vs长词块对流畅性 (System) ⭐⭐

| ① 论文讲了什么 | ② 与本项目的对比 | ③ 参考价值（词块操作化最完整） |
|---|---|---|
| **PI团队自己的论文，本项目直接前身**。50名日本EFL。发现**长词块(4-5词)贡献在于减少mid-clause停顿、减少修补**(非加速)；短词块高MI反拖慢。 | 方法论与我们工作流**同源**(Praat半自动+人工复核, AI转写+人工校对)；独白 vs 我们对话；停顿阈值用350ms vs 我们250ms(冲突点)。 | **长度分类**：短=2-3词(TAALES+COCA)；长=4-5词(AntConc)；排除6-7词。**4词阈值：≥3次且≥3文本**。**重叠合并**：共享3词且频率/range差≤4→合并5词。**缩略词算1词**。⚠️**本篇用350ms**(PI改250ms,注意区分)。子句=ASU；repair按speaking time归一。流程：`mark_pauses.praat`→人工频谱核查→`calculate_segment_durations.praat`。统计：稳健回归+优势分析+随机森林(小样本适用)。 |

### 6. Hougham et al. (2024) — 词块长度对口语水平 (Languages)

| ① 论文讲了什么 | ② 与本项目的对比 | ③ 参考价值 |
|---|---|---|
| 上一篇的"**水平(proficiency)**"姊妹篇。150名预科生**独白演讲**。发现 **bigram MI是最强预测因子(优势权重58.6%)**，长词块次之(18.8%)；关键在词块**质量(高MI)而非数量**。 | 独白 vs 我们对话(我们可填补"非独白"空白)；中高水平(IELTS6.5-7.5)无低水平者。方法与第5篇几乎相同。 | **Wood & Appel (2014) 精炼程序**：四词拆两个三词簇，**一簇频率≥另一簇2倍→定为根结构**，第4词入括号(`I will give (you)`)。最终清单：3词55+4词58+5词6=119个。计分：每用一个记1分+累加MI分。缩略词=1词。 |

### 7. Takizawa & Suzuki (2025) — MWS在流利感知中的作用 (SSLA) ⭐

| ① 论文讲了什么 | ② 与本项目的对比 | ③ 参考价值 |
|---|---|---|
| 102名日本学习者**独白**，问"控制utterance fluency后MWS是否独立预测**感知流利度**"。发现UF(尤其**mid-clause pause ratio单独解释44.9%**)绝对主导；控制后仅bigram proportion独立显著但增量仅0.8%。 | 独白+感知 vs 我们对话+产出。⚠️本篇**没直接测"停顿相对MWU位置"**——这正是**我们的创新空间**。 | **mid/end-clause权威操作定义**(依Foster et al. 2000)：mid=子句内部停顿；end=子句间边界停顿。**量化**：pause ratio=该位置停顿数/**音节总数**；pause duration=平均时长。强印证：**mid-clause停顿≈找词/找短语困难**=MWS缺失体现。**用MFA词级对齐把停顿落点映射到MWS边界(内部/前/后)**=Foster(2020)呼吁但前人未做的方向。 |

---

## 第三组：对话流畅性（与本项目数据形态直接相关）

### 8. Tavakoli (2016) — 独白 vs 对话流畅性 (IRAL) ⭐⭐

| ① 论文讲了什么 | ② 与本项目的对比 | ③ 参考价值（对话测量命门） |
|---|---|---|
| 35名B2学生，被试内对比独白与对话。发现对话**更流畅**(语速快/停顿短/修补少)，但**停顿数量和位置无差异**(两模式都更多mid-clause停顿)。最大贡献：**测量操作化方式决定结论**——between-turn pause怎么算会改变结果。 | **最贴近我们的数据形态**(对话)。我们是3人，between-turn归因比其2人更复杂。 | 阈值250ms；位置clause-internal/external；音节核用de Jong&Wempe 2009。**between-turn pause三种处理**：排除/均分/CA归因——**3人对话建议先标注暂不强行归因，导出保留原始turn边界做敏感性分析**。**稳健指标**(推荐主指标)：MLR、articulation rate、mid-clause停顿数。**脆弱指标**(需双口径报告)：speech rate、mean length of pause、总停顿数、end-clause停顿、PTR。质控：单方>70%主导则剔除；每人60s内≥2 turn。 |

---

## 第四组：补充文献（EXTRA · 含参考价值分级）

### 9. Uchihara et al. (2026) — 对话中 MWS 不预测水平 (Modern Language Journal) ⭐⭐

| ① 论文讲了什么 | ② 与本项目的对比 | ③ 参考价值（对项目假设的根本警示） |
|---|---|---|
| 127名考生**配对对话**。结论(如标题)：**8个n-gram指标无一显著预测水平**。原因：**配对层面解释30-42%方差**(说话人互相"词汇对齐")；**同国籍配对会"抬高"低水平者的MWS产出**。 | **与我们对话数据高度同形**，结论直接冲击"MWU多=水平高"的默认假设。 | **不要默认个体MWU多=水平高**(可能是群体带动)。**必须把triad作为随机效应/分析单位**(混合效应模型)，先算ICC。**记录控制背景变量**(L1匹配、熟悉度)。**对话需增加"话轮边界"停顿类别**。转写信度：20%双盲，一致率96%。⭐若我们也发现"MWU不预测对话流畅性/水平"，这**与文献一致、是可发表的正面贡献**，不算失败。 |

### 10. Hougham (2025) — 博士论文(4个研究, 279页) ⭐⭐

| ① 论文讲了什么 | ② 与本项目的对比 | ③ 参考价值（最贴近项目、流程最完整） |
|---|---|---|
| 第5、6篇的完整版+扩展。系统研究词块长度对流畅性与水平的影响，提出"**倒U形**"关系(词块复杂度过高反削弱处理优势)。 | 单人演讲独白 vs 我们3人对话；**未用MFA、未报对齐准确率、未明确de Jong&Wempe脚本**——**这三点正是我们的方法升级点**。 | 全套可落地基线：静默**≥250ms**；停顿分mid-ASU/end-ASU；**分母用speaking time(排除静默)**。完整Praat流程(mark_pauses→人工频谱核查→calculate_segment_durations→逐一标mid/end)。词块双路径+精炼程序(≥3次/≥3文本、2倍频率定根、缩略词=1词)。基线值：mid-ASU停顿/分钟随水平21.8→18.9→17.5；total repair 3.3→2.4→2.0。 |

### 11. Uchihara & Suzuki (2025) — 词汇练习时机与MWE学习 (SSLA)

| ① 论文讲了什么 | ② 与本项目的对比 | ③ 参考价值：**中等偏低** |
|---|---|---|
| 80名学习者，fNIRS脑间同步实验，研究"任务前vs任务后词汇练习"对动名搭配学习的影响。主线是**词汇习得+神经科学**。 | **无任何流畅性工作流要素**(无停顿阈值/位置/音节核/MFA)。与我们工作流方法论几乎无交集。 | 可借：①MWE操作定义——动名搭配，**统计标准MI≥3 vs 功能/任务标准双轨**；②以单个MWE为窗口、含停顿、按音节/秒测局部速度；③信度报告范式。定位为"MWE界定"补充引文。 |

### 12. Brown et al. (2023) — 语用标记与流利感知 (System) ⭐

| ① 论文讲了什么 | ② 与本项目的对比 | ③ 参考价值：**中等偏上(定义层面)** |
|---|---|---|
| matched-guise实验，问"专家式使用语用标记(PM)是否提升L2流利**感知**"。发现PM小幅提升(仅解释3%方差)，主要由L1听者驱动；存在对L2说话人的感知偏见。 | 感知研究 vs 我们产出测量；声学参数它"控制掉"了。但PM定义层面对我们转写标注直接有用。 | ⭐**PM/discourse markers本身就是一类MWU**(you know/I mean/sort of)——逐字转写**必须保留并单独标注**。**关键区分**：`uh/um`(填充停顿=breakdown)≠`well/you know`(语用标记=流畅性资源/MWU)。可用**Fung & Carter (2007) 四类PM清单**。基线：PM占L1词数9-19%，人际:认知≈70:30。声学参数需回到de Jong&Wempe、Bosker et al. 2013。 |

---

## 第五组：项目自有研究计划（理解"需求规格"最关键）⭐⭐⭐

### 13. BAAL 2026 摘要 — *Beyond Monologues*

| ① 摘要讲了什么 | ② 与本项目的对比 | ③ 参考价值（开发需求） |
|---|---|---|
| 作者Hollis/Clenton/Hougham/Brooks。RQ：**多人对话(multilogues, 3+人)** 中，词块**长度与频率**如何预测L2流畅性、如何随CEFR变化。假设：正相关，**中级最强、高级减弱**。方法：120人(CEFR A2-C1各30)；PRAAT标注；**停顿类型一致性κ>.85**；TAALES+AntConc+精炼程序。 | **这就是我们项目要服务的研究**(3人对话=multilogue)。 | 工作流必须产出：**带说话人/话轮、精细停顿类型与位置、可变长度且处理重叠的MWU**，导出可喂TAALES/AntConc及混合效应模型的结构化表。停顿类型标注需可被AI预填+人工核改+计算一致性(双标注比对)。 |

### 14 & 15. KAKEN 2026 申请书（FINAL SUBMITTED & Project Outline）

> 两份的**项目计划提纲正文完全相同**；FINAL 多了封面/成员/预算表。

| ① 申请讲了什么 | ② 与本项目的对比 | ③ 参考价值（= 需求规格书） |
|---|---|---|
| 课题：*Unlocking L2 Conversational Fluency: The Significance of Lexical Bundle Length in High-Stakes Speaking Assessment*。基盘(C)，2026-2029，PI=Hollis，**Gavin Brooks负责Python/R脚本+监督PRAAT标注(=对接人)**。痛点：高利害考试85%是对话却用独白式评分一刀切惩罚停顿，**无法区分"mid-clause失流(该扣分)" vs "end-clause战略停顿(该奖励)"**。三个RQ围绕LB长度×speed/breakdown/repair×对话评分(turn smoothness, responsiveness)。 | **整个项目的需求源头与理论命脉**。我们的工作流是其方法论4.1节的落地工具；预算显示**PRAAT人工标注是最大单项人力支出**=我们工具的核心价值点。 | 参数：**LB设4-8词、MI≥3.0**；120人分层(A2-C1)+50跨语言对照；30秒计时轮换；**20%双编码κ>.85/Krippendorff α>.80**；线性混合效应模型(需**long-format tidy表**)；预注册OSF。提取指标：articulation rate、mid-clause pauses、**turn transition latency(话轮转换延迟)**。6层TextGrid须覆盖：转写词层/说话人话轮层/停顿层(含mid-end位置)/话轮转换层/修复层/MWU层。 |

---

## 全局可落地参数汇总表

| 项目 | 取值 | 来源 |
|---|---|---|
| 静默停顿阈值 | **250 ms**（注：Hougham旧文用350ms） | de Jong&Bosker 2013；Tavakoli&Uchihara 2020；KAKEN |
| 停顿位置 | **mid-clause / end-clause**（按 **AS-Unit** 切分） | Foster et al. 2000；Takizawa&Suzuki 2025 |
| 速度指标 | **articulation rate = 音节/发声时长**（纯速度,务必纳入） | Tavakoli 2020 |
| 计数单位 | **音节**（非词） | Tavakoli 2020；de Jong&Wempe 2009 |
| 归一化分母 | **speaking time（排除静默）** | Hougham 2025；de Jong 2016b |
| 短词块 | 2-3词，**TAALES+COCA口语子库**，proportion(前30k)/对数freq/MI | Hougham 2024系列 |
| 长词块 | 4-5(8)词，**AntConc**，阈值 **≥3次 & ≥3文本**，**MI≥3.0** | Hougham 2024；KAKEN |
| 词块精炼 | 2倍频率定根+括号；缩略词=1词；重叠合并共享3词 | Wood&Appel 2014；Appel&Wood 2016 |
| 转写 | 逐字unpruned(流畅性用)+派生清洗版(MWS用) | Tavakoli&Uchihara 2020 |
| 信度 | 20%双编码，κ>.85 / α>.80 | KAKEN；BAAL |
| 统计 | 混合效应模型(**triad/speaker作随机效应**)，long-format | Uchihara 2026；KAKEN |

---

## 关键警示（务必注意）

1. **缺两篇关键方法论文**：250ms阈值原始出处与音节率公式在 **de Jong & Wempe (2009)** 和 **"Facets of Fluency"(de Jong et al. 2012姊妹篇)**，**当前 docs 里没有**，建议向 Chris 索取。
2. **停顿阈值冲突**：Hougham旧文用 **350ms**，PI/KAKEN现定 **250ms**——以250ms为准并记入方法日志。
3. **数据是对话不是独白**：90%文献参数来自独白，**必须新增"话轮边界/轮间静音"作为第三类停顿**，否则会把正常轮替误判为不流畅。
4. **群体对齐效应**：对话中MWU 30-42%方差来自配对——分析必须以triad为单位。
5. **我们的方法增量 = MFA词级对齐 + 报告对齐准确率**：Hougham全系列没做，能把"停顿相对MWU位置(内部/前/后)"真正落地(Foster 2020呼吁、前人未做)。
6. **PM/discourse markers既是MWU又是流畅性资源**：转写要保留并与填充词分开标注。
