# Task 11：基于 usage 的自动 Compact

## 改动总结、效果和原因

本章按最后确认的 **Pi 风格 Session 协调方案**实施。旧稿中“Loop 请求前 Hook + 全量字节估算”的设计已被替代，不要再照旧稿给 Loop 加压缩逻辑。

| 改动 | 效果 | 原因 |
|---|---|---|
| 普通响应和 SSE 解析 usage | 保存本次输入、输出与缓存用量 | 优先使用真实统计 |
| 引入 SessionRuntime | 提问前、任务完成后检查用量 | Agent 执行任务，Session 维护历史 |
| 自动复用 compactSession | 摘要落盘后替换有效消息，原历史保留 | 手动、自动共用提交顺序 |
| 溢出时 compact + continue 一次 | 工具结果过大时有恢复机会 | 不重放 prompt 和已完成工具 |
| CLI 接入协调器 | 展示压缩、查看状态、取消、退出 | 锁覆盖普通请求和摘要阶段 |

本章不改 agent.ts、agent-loop.ts、工具和 Skill 的执行方式。

状态：已实现；2026-09-30 类型检查通过，全量 110 项本地自动化测试通过。真实服务商的摘要质量尚未手工验收。

## 一、先用一个例子理解

应用窗口 32,768，提前预留 4,096：

~~~text
阈值 = 32768 - 4096 = 28672
上一条完整回答：输入 27000 + 输出 1800 = 28800
28800 > 28672 → 任务结束、Agent 空闲后，生成历史摘要
摘要保存成功 → 内存变成“摘要 + 最近两个 user 分组”
下一次提问 → 模型看到整理后的上下文
~~~

比较的是**本次上下文用量**，不是把会话里所有 API 请求费用加起来。

如果中途工具返回很大，下一次请求直接被服务端拒绝：

~~~text
user → assistant(toolCalls) → toolResult → 上下文溢出
Agent 收尾 → Session 压缩旧分组 → agent.continue()
模型读取保留的 toolResult → 继续回答
~~~

不能调用 prompt(原问题) 重试：会多存一条 user，也可能让模型重新做已经做过的文件操作。

## 二、文件地图与阅读顺序

| 文件 | 重点职责 |
|---|---|
| src/types.ts | AssistantMessage 增加 usage、usageContextKey；LLM 可提供当前配置指纹 |
| src/llm-usage.ts | 归一化 OpenAI/DeepSeek 用量，严格识别上下文溢出 |
| src/real-llm.ts | 请求流式 usage，解析独立统计帧 |
| src/context-budget.ts | 校验预算；最近有效 usage + 后续增量 |
| src/session/session-runtime.ts | 运行锁、阈值、自动压缩、一次恢复、取消 |
| src/cli-agent-runner.ts | 依赖最小控制接口，展示 Session 压缩状态 |
| src/main.ts | 装配协调器、预算、压缩显示回调 |
| test/llm-usage.test.ts | 缓存、SSE 末帧、溢出分类 |
| test/auto-compaction.test.ts | 触发、过期统计、恢复、取消、提交一致性 |
| test/cli-compact-process.test.ts | 真实 CLI 进程与本地 HTTP 集成 |

原 createSessionAgent 仍负责加载历史、注册持久化监听器。
新的 createSessionRuntime 在外面包一层协调器；裸 Agent 仍可独立运行。

## 三、usage 从哪里来

SSE 请求增加：

~~~ts
stream_options: {include_usage: true}
~~~

服务端可能最后才返回：

~~~json
{"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":30}}}
~~~

重点：choices 为空不代表没有信息。先取 usage，再判断文本或工具增量。

归一化为：

~~~ts
{
    input: 70,       // 非缓存输入
    output: 20,
    cacheRead: 30,
    cacheWrite: 0,   // 当前适配器未单独报告缓存写入
    totalTokens: 120
}
~~~

prompt_tokens=100 已包含缓存的 30，不能算成 100+30+20。
DeepSeek 的 prompt_cache_hit_tokens 也按同样逻辑拆分。

完整 assistant 经原有 message_end → appendMessage 保存 usage。
碎片不落盘；toApiMessages 不会把 usage 等本地元数据发回模型。
独立摘要请求的用量也不会成为正常对话的统计基线。

## 四、tools 和 Skill 怎么算进去

上次正常请求的输入统计已经包含当时的 systemPrompt、Skill 索引、工具 schema 和历史消息。不能再次重复相加。

~~~text
最近有效 assistant.usage.totalTokens
+ 该 assistant 后新增消息的保守字节估算
= 当前上下文参考量
~~~

仅增量使用 UTF-8 字节估算，包含正文、工具参数与结果，不含本地 details/usage。
它不是精确 tokenizer，也不保证绝不溢出。

两种情况必须让旧统计失效：

1. **发生压缩。** 从 JSONL 尾部逆序查找 usage，遇到 compaction 停止。保留消息里的旧 usage 描述的是压缩前整个请求。
2. **配置变化。** 模型、服务地址、systemPrompt、tools 定义变化，配置指纹不同。指纹不含 API Key。

缺失、非法、全零 usage 不触发阈值压缩。没有新鲜统计时暂不做预防压缩；真正溢出仍可恢复一次。

## 五、SessionRuntime 方法关系

~~~text
prompt(text) / continue()
  → exclusive：同步建立 Session 锁、取消控制器
  → run
      → checkThreshold：用已有统计预检查
      → agent.prompt(text) 或 agent.continue()
      → 明确溢出：autoCompact("overflow") → agent.continue() 一次
      → 正常 completed：checkThreshold 再检查最新用量
  → 清理 Session 锁，waitForIdle 可以返回

手动 compact(signal)
  → 相同 exclusive 锁
  → compactSession（原 Task 09）
~~~

run 收集整段逻辑任务的完整消息。发生恢复时，返回的 newMessages 仍包含第一次运行产生的 user、assistant、toolResult；合成摘要不计作新消息。

state.isRunning 仍表示 Agent Loop 是否运行；SessionRuntime.isCompacting 表示正在维护历史。CLI 的 activePrompt 覆盖整个过程，所以 Loop 空闲不等于允许切会话。

压缩期间 /steer、/followup 明确提示稍后输入，不接受后悄悄丢弃。正常 Agent 运行阶段的队列逻辑不变。
SessionRuntime 的公共 steer/followUp 接口也执行相同检查，不只依赖 CLI。

## 六、为什么没有死锁、没有丢消息

压缩不在 Loop 内调用。只有 Agent 已经收尾，或者尚未开始新 Run，才调用 compactSession。

~~~text
生成摘要 → 检查摘要 → 计算新上下文 → 检查取消
→ appendCompaction 成功 → 立即 replaceMessages
~~~

保存失败不能应用内存；保存成功后即使取消，也必须完成内存应用。
旧消息不删除，重开 JSONL 根据最新 compaction 恢复。
按 user 分组保留，不拆开工具调用与结果。

## 七、失败与恢复边界

| 情况 | 行为 |
|---|---|
| 阈值以下、没有有效 usage | 不生成摘要 |
| 没有旧分组 | 跳过，不显示虚假的压缩完成 |
| 阈值摘要失败 | 事件报告错误，保留原上下文，不抹掉已完成回答 |
| HTTP 明确上下文溢出 | 摘要成功后 continue 一次 |
| 重试再次溢出 | 报错，不无限循环 |
| 普通 400、鉴权、网络失败 | 不作为溢出重试 |
| 只有一个超大任务 | 提示缩小输入或新建会话 |
| 摘要失败、空白、返回工具 | 不追加 compaction；溢出路径不续跑 |
| 取消 | 传入摘要请求，等待收尾，不继续请求模型 |
| 保存失败和取消同时发生 | 保留 Agent 已传播的保存错误，不能伪装成取消成功 |
| v1 Session | 普通消息仍可读写；不自动迁移，压缩报告不支持 |

错误分类只接受明确 code，或受限的“最大上下文 + 请求数量超过”文案，不匹配任意包含 token 的错误。
一次恢复会启动新的 Agent Run，因此使用新的 maxTurns 预算；Session 的恢复次数本身仍限制为一次。

## 八、配置与体验

CLI 默认应用预算 32,768、提前余量 4,096，**不是自动探测模型窗口**。
IDEA 当前 Node.js 配置可增加环境变量：

~~~text
AGENT_CONTEXT_WINDOW=32768
AGENT_COMPACT_RESERVE=4096
~~~

窗口不能超过实际模型能力。reserveTokens 是提前触发余量，不是强制指定正常生成的 max_tokens。摘要沿用 maxOutputTokens: 2048。
非法数字、负数、reserve 大于等于 window 会在装配时拒绝。

库调用不传 autoCompact 就不自动压缩；手动 compact 仍可使用：

~~~ts
const runtime = await createSessionRuntime(store, {
    llm, tools, systemPrompt,
    autoCompact: {contextWindowTokens: 32768, reserveTokens: 4096},
    onCompaction: (event) => console.log(event),
});
await runtime.prompt("继续之前的任务");
~~~

体验时先观察是否报告 usage，不要只把预算改得极小。当前保留两组，小预算不一定有可压缩空间。

## 九、流程图与断点

~~~mermaid
flowchart TD
    A[CLI 输入] --> B[Session 建立整段运行锁]
    B --> C[根据最近有效 usage 检查]
    C --> D[必要时调用压缩核心]
    D --> E[Agent prompt / continue]
    E --> F{执行结果}
    F -- 正常完成 --> G[检查新 usage]
    G --> H[必要时整理历史后结束]
    F -- 明确溢出 --> I[保留已保存消息]
    I --> J[压缩旧分组]
    J --> K[continue 一次]
    K -- 成功 --> G
    K -- 再失败 --> L[报告错误并释放锁]
    F -- 其他失败 --> L
~~~

推荐断点：

1. chatStream 收到 usage 帧：choices 为空时仍取统计。
2. estimateContextTokens：compaction 截断旧统计。
3. checkThreshold：比较用量和 window-reserve。
4. compactSession 的 appendCompaction 前后：磁盘与内存提交顺序。
5. SessionRuntime.run 的 overflow 分支：continue 不重复添加 user。

## 十、实施决策与进度

- 决策：替换旧 Hook 方案，Session 运行前后协调——符合最后确认的 Pi 学习方向；代价是工具循环中不逐轮主动预检，依赖一次明确溢出恢复。
- 决策：仍保留两组完整 user 消息——先跑通触发与恢复；代价是近期单组过大仍无法压缩，按 Token 选切点留到后续。
- 决策：没有 usage 不做阈值触发——不伪造精确计数；代价是部分兼容服务依赖手动压缩或溢出恢复。
- 决策：在当前学习项目内修改，不创建额外工作树，不提交 Git——便于在 IDEA 继续调试，保留已有文档改动。
- 决策：压缩阶段拒绝新增队列指令——减少第一版状态组合；代价是用户需要稍后输入。

测试使用假模型和本地 HTTP，包含真实 CLI 子进程，不消耗真实模型用量。
新增测试已加入 package.json 原清单，不删除旧测试，不新增依赖。
最终验证：npm run check 通过；全量 node --test 为 **110/110**；git diff --check 无空白错误。

独立 review 后完成的一次修复：

- 保存错误被并发取消覆盖：回归先失败，再修复，只把真正的取消异常转换成 aborted。
- 公共队列接口绕过压缩限制：原评为 Minor，本次按重要行为问题处理，因为指令可能延迟到不相关任务；手动、自动两个路径都有失败后通过的回归测试。
- 不将固定两组、单个巨大 Turn 无法压缩、恢复使用新 Run 预算、没有通用网络重试视为本次缺陷：均为本章明确边界，扩展成本留到后续。
- 没有遗留的本次 review 修复项；没有提交 Git，也没有调用真实模型验收摘要质量。

~~~powershell
npm run check
$taskTestFiles = @(rg --files test -g '*.test.ts')
node --test @taskTestFiles
git diff --check
~~~

本章链路：**usage → 阈值 → Session 协调 → 一次溢出恢复**。
按 Token 保留、超长 Turn 切分、分块摘要是后续学习，不在本章声称完成。
