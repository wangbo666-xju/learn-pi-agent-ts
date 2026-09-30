/** 将指定 Git 版本与教学代码嵌入 HTML。只生成学习资料，不修改 Agent 或 Git 工作区状态。 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {lessonGuides} from './learning-map-lessons.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = new URL('../docs/AGENT_LEARNING_MAP.html', import.meta.url);
const html = readFileSync(target, 'utf8');
const main = html.match(/<script id="map-app">([\s\S]*?)<\/script>/)?.[1];
assert.ok(main, '找不到地图内容');
const chapterSource = main.slice(main.indexOf('const chapters ='), main.indexOf('const groups='));
const chapters = new Function(chapterSource + ';return chapters;')();
const lessons = {
    F01: {
        revision: '27ad7e9', files: ['src/agent.ts'],
        excerpt: ['src/agent.ts', '    async prompt(', '\n}\n\nexport default Agent'],
        note: '这是最早提交中的 prompt 方法。messages 每次调用都重新创建；尚无 SSE、Session、队列、取消或最大轮数。原始代码保留原貌，不作为最新版复制模板。',
    },
    F02: {
        revision: 'c6fc192', files: ['src/types.ts'], whole: 'src/types.ts',
        note: '早期 Tool 只有 name 与 execute，参数写死为 path。schema、isError、流式事件和 usage 都是后续增加的。',
    },
    F03: {
        revision: 'c6fc192', files: ['src/fake-llm.ts'], whole: 'src/fake-llm.ts',
        note: '早期 Fake 通过历史里有没有 toolResult 决定回复，并不是当前的预设回复队列；它已经足以让你调试两轮调用。',
    },
    F04: {
        revision: 'c6fc192', files: ['src/read-file-tool.ts'], whole: 'src/read-file-tool.ts',
        note: '当时文件直接放在 src 下，readFile 使用原始路径；还没有 tools 子目录、schema、工作区路径限制和取消信号。',
    },
    F05: {
        revision: '49f5488', files: ['src/real-llm.ts', 'src/types.ts'],
        note: '提炼当时的非流式适配过程。ApiToolCall 是网络格式，内部 ToolCall 才交给 Agent；这里省略鉴权和报错细节。',
        code: `// 教学伪代码：内部协议 ⇄ OpenAI 兼容接口
const response = await fetch(baseUrl + "/chat/completions", {
  messages: toApiMessages(messages),
  tools: toApiTools(tools),
});
const apiMessage = (await response.json()).choices[0].message;
return {
  role: "assistant",
  content: apiMessage.content ?? "",
  toolCalls: apiMessage.tool_calls?.map(call => ({
    id: call.id,
    name: call.function.name,
    arguments: JSON.parse(call.function.arguments),
  })),
};`,
    },
    F06: {
        revision: '98f834c', files: ['src/agent.ts'],
        note: '这个提交先把异常变成结果文本，没有 isError 字段；结构化成功/失败状态是 6a5e4f5 才加入的。不要把今天的 executeTools 当成这一版。',
        code: `// 教学伪代码：当时仍在 Agent.prompt 内执行工具
for (const call of reply.toolCalls) {
  const tool = tools.find(tool => tool.name === call.name);
  // 找不到工具时也构造一条错误文本结果（此处省略该分支）
  let result;
  try {
    result = await tool.execute(call.arguments);
  } catch (error) {
    result = "工具执行失败: " + error.message;
  }
  messages.push({role: "toolResult", toolCallId: call.id, content: result});
}
// while 继续：让模型看到失败，而不是在这里崩溃`,
    },
    F07: {
        revision: '20a2f0c', files: ['src/real-llm.ts'],
        note: '此阶段只有 onText 回调，不是 LlmStreamEvent。当时 EOF 也会正常返回；“缺少 [DONE] 必须报错”是后来的流边界修复，不能倒写到早期版本。',
        code: `// 教学伪代码：省略 HTTP 配置和空行判断
while (true) {
  const {value, done} = await reader.read();
  buffer += decoder.decode(value, {stream: !done});
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? ""; // 半行留给下一个网络 chunk
  for (const line of lines) {
    const payload = readDataLine(line);
    if (payload === "[DONE]") return;
    onChunk(JSON.parse(payload));
  }
  if (done) return; // 早期版本的实际边界
}
// chatStream 累加 content / arguments，完整返回后再执行工具`,
    },
    F08: {
        revision: 'c6db98a', files: ['src/agent.ts', 'src/execute-tools.ts', 'src/tool-policy.ts', 'src/tools/tool-util.ts'],
        note: '用这一阶段的累计版本回看多工具、轮数和 before 策略；它还不是 Task 05 的完整工具生命周期。',
        code: `// 教学伪代码：把限制放在相应边界
if (round >= maxRounds) throw new Error("工具调用轮数超限");
const decision = await beforeToolCall?.(call);
if (decision?.block) {
  return errorResult(decision.reason);
}
// 具体工具仍要限制路径，不能只依赖模型遵守要求
const path = resolvePath(workspaceRoot, args.path);
await writeFile(path, args.content, "utf8");
return "已写入";`,
    },
    F09: {
        revision: 'dcd672e', files: ['src/session/types.ts', 'src/session/session-store.ts', 'src/session/jsonl-session-store.ts'],
        note: '初版是普通消息的线性存储，还没有 compaction Entry。当时 appendMessage 已经先写磁盘、再更新内存；此处省略 ID/时间戳生成与内存副本处理。',
        code: `// 教学伪代码：消息成为可恢复的记录
const entry = {
  type: "message", id: newId(), seq: nextSeq(),
  timestamp: Date.now(), message,
};
await appendFile(sessionPath, JSON.stringify(entry) + "\\n");

// 再次启动：按行解析，恢复原有消息
const entries = lines.map(line => JSON.parse(line));
const messages = entries
  .filter(entry => entry.type === "message")
  .map(entry => entry.message);`,
    },
    F10: {
        revision: '799a252', files: ['src/cli-command.ts', 'src/session/session-manager.ts', 'src/main.ts'],
        note: '这是初版多会话 CLI。输入循环仍然等待 prompt 完成；“运行中继续收 /abort”要到 Task 07。',
        code: `// 教学伪代码：每次切会话，装配对应历史的 Agent
for await (const line of input) {
  const command = parseCliCommand(line);
  if (command.type === "new") {
    store = await sessions.create();
    agent = createAgent(store);
  } else if (command.type === "resume") {
    store = await sessions.open(command.sessionId);
    agent = createAgent(store);
  } else if (command.type === "prompt") {
    await agent.prompt(command.text); // 初版仍阻塞下一次输入处理
  }
}`,
    },
    F11: {
        revision: 'f3db6b4', files: ['src/skills/skill-invocation.ts', 'src/skills/skill-loader.ts', 'src/skills/system-prompt.ts'],
        whole: 'src/skills/skill-invocation.ts',
        note: '显式 Skill 调用只是构造一个字符串，再复用 prompt。additionalInstructions 就是 /skill:name 后用户额外输入的要求。',
    },
    '01': {
        revision: '30b1fe5', files: ['src/agent-state.ts', 'src/agent-events.ts', 'src/agent.ts'],
        note: 'State 是当前状态，Event 是变化通知；本章还没有抽出独立 agent-loop.ts。省略事件联合类型的其他成员。',
        code: `// 教学伪代码：显示临时输出，不重复保存完整消息
switch (event.type) {
  case "message_update":
    state.streamingMessage = event.message;
    break;
  case "message_end":
    state.streamingMessage = undefined;
    break;
}
await events.emit(event); // 让多个订阅者看到同一个变化`,
    },
    '02A': {
        revision: '1b96ff0', files: ['src/types.ts', 'src/real-llm.ts', 'src/agent.ts'],
        note: '当时语义事件在 Agent 内消费；后续 Task 03 才迁到 Loop。下面省略工具碎片累计，只展示两层事件的交接。',
        code: `// 教学伪代码：LLM 适配器发模型语义事件
await onEvent({type: "start", partial});
partial.content += delta;
await onEvent({type: "text_delta", delta, partial});
await onEvent({type: "done", message: completeMessage});

// Agent 消费，翻译成应用可订阅的事件
await emit({type: "message_update", message: event.partial,
  update: {type: "text_delta", delta: event.delta}});
// 最终 done → message_end，而不是把每个 delta 当一条历史`,
    },
    '02B': {
        revision: '25ba2d8', files: ['src/context.ts', 'src/agent.ts'],
        note: '本阶段仍由 Agent 调用 Context；后面 Loop 抽出后调用位置才改变。复制的是顶层数组，不是消息对象深拷贝。',
        code: `// 教学伪代码：每次请求都经过同一个输入准备点
let prepared = [...messages];
if (transformContext) {
  prepared = await transformContext(prepared, signal);
}
const llmMessages = await convertToLlm(prepared);
const reply = await llm.chatStream(llmMessages, tools, onEvent);
// 临时转换不等于修改 Session 中保存的历史`,
    },
    '03': {
        revision: '6db081e', files: ['src/agent.ts', 'src/agent-loop.ts'],
        note: '这是 Loop 抽取阶段的正常调用主链。历史文件可能还有当时的缺陷；取消、continue 与双层队列以 Task 04 为界，不在此处提前引入。',
        code: `// 教学伪代码：Agent 提供 API，Loop 编排一轮
await appendInputAndEmit(userMessage);
while (true) {
  const input = await prepareLlmContext(context.messages, config);
  const reply = await llm.chatStream(input, tools, translateEvent);
  // 完整 assistant 只追加一次（包括 done/return 的去重）
  await appendAssistantOnce(reply);
  if (!reply.toolCalls?.length) return completed();
  const result = await executeTools(tools, reply, {beforeToolCall, emit});
  for (const message of result.results) {
    await appendAndEmit(message);
  }
}`,
    },
    '04': {
        revision: '029d17a', files: ['src/agent.ts', 'src/agent-loop.ts', 'src/message-queue.ts'],
        note: '只展示正常路径；每轮还受 signal、maxTurns、错误和 terminated 约束。steer 等当前 Turn 的整批工具完成，并不抢占正在执行的工具。',
        code: `// 教学伪代码：内层续跑当前任务，外层接后续任务
while (true) {
  while (true) {
    const turn = await runTurn();
    if (turn.mustStop) return finish(turn.reason);
    const steering = steeringQueue.drain();
    if (steering.length) { await appendInput(steering); continue; }
    if (turn.hasToolCalls) continue;
    break;
  }
  const followUps = followUpQueue.drain();
  if (!followUps.length) return completed();
  await appendInput(followUps);
}`,
    },
    '05': {
        revision: '71681a1', files: ['src/execute-tools.ts', 'src/tool-arguments.ts', 'src/tool-policy.ts'],
        note: '省略取消与错误收集，只聚合生命周期。after 只用于真正执行过的工具；before 拒绝不经过 execute/after。',
        code: `// 教学伪代码：串行处理一次 assistant 的整批调用
for (const call of reply.toolCalls) {
  await emit(toolStart(call));
  const tool = findTool(call.name);
  validateToolArguments(tool, call.arguments);
  const decision = await beforeToolCall?.(call);
  let result;
  if (decision?.block) result = blockedResult(call);
  else {
    result = await executeAndCaptureToolError(tool, call, {
      signal, onUpdate: update => emit(toolUpdate(call, update)),
    });
    if (!signal?.aborted) result = await applyAfterHook(result);
  }
  await emit(toolEnd(call, result));
  collectToolResult(call, result);
}`,
    },
    '06': {
        revision: '15cc6d1', files: ['src/session/session-event-listener.ts', 'src/session/create-session-agent.ts', 'src/session/jsonl-session-store.ts'],
        whole: 'src/session/session-event-listener.ts',
        note: '核心就这一个监听器。工厂负责注册它，EventBus 顺序 await；因此完整消息保存成功后，Loop 才继续后续步骤。',
    },
    '07': {
        revision: '5845023', files: ['src/cli-agent-runner.ts', 'src/cli-event-renderer.ts', 'src/main.ts'],
        note: '把运行 Promise 交给 Runner 管，输入循环不 await 整个 prompt。下面省略命令校验、重复退出与异常报告。',
        code: `// 教学伪代码：输入控制与事件输出分开
function startPrompt(text) {
  activePrompt = agent.prompt(text)
    .catch(reportError)
    .finally(() => { activePrompt = undefined; });
}
for await (const line of input) {
  const command = parseCliCommand(line);
  if (command.type === "abort") agent.abort();
  else if (command.type === "prompt") startPrompt(command.text);
}
// EOF / exit：先取消，再等正在运行的 Promise 和收尾
agent.abort();
await activePrompt;
await agent.waitForIdle();`,
    },
    '08': {
        revision: 'bebd085', files: ['test/agent-acceptance.test.ts', 'test/cli-process.test.ts'],
        note: '这一课不是新增运行模块，而是验证组合行为。下面聚合用例意图，不是某个测试文件的逐字复制。',
        code: `// 测试伪代码：模型响应可控，运行的是实际 Agent
llm.enqueue(toolCall("read", {path: "README.md"}));
llm.enqueue(finalAnswer("读取完成"));
const result = await agent.prompt("读 README");
assert.equal(result.reason, "completed");
assert.deepEqual(messages.map(m => m.role), [
  "user", "assistant", "toolResult", "assistant",
]);
assert.equal(agent.state.isRunning, false);
// 另用真实 CLI 子进程 + 本地 SSE 服务验证输入/输出/退出`,
    },
    '09': {
        revision: 'ab258b1', files: ['src/compaction.ts', 'src/session/build-agent-context.ts', 'src/session/types.ts'],
        note: '手动压缩阶段只在空闲时运行。旧记录保留在 JSONL；模型使用“摘要 + 保留消息”，不是删除磁盘历史。',
        code: `// 教学伪代码：先生成，再提交，最后应用
assertAgentIdle();
const plan = prepareCompaction(await store.getEntries()); // 默认保留最近两组
if (!plan) return skipped();
const summary = await summarize(plan, llm, signal); // tools=[]
throwIfAborted(signal);
await store.appendCompaction({
  summary,
  firstKeptEntryId: plan.firstKeptEntryId,
});
agent.replaceMessages(buildAgentContext(store.getEntries()));`,
    },
    '10': {
        revision: 'ab258b1', files: ['test/compaction.test.ts', 'test/cli-compact-process.test.ts', 'src/compaction.ts'],
        note: 'Task 09 和 10 的实现/验收一起落在 ab258b1，没有单独“第十章提交”。此处明确共用这个历史版本。',
        code: `// 测试伪代码：三个失败位置的结果不同
// 1. 摘要失败 / 保存前取消
assert.deepEqual(agent.messages, oldMessages);
assert.noNewCompaction(store);

// 2. appendCompaction 失败
assert.deepEqual(agent.messages, oldMessages);

// 3. 保存成功后才收到取消：不能放弃应用
await store.appendCompaction(entry);
agent.replaceMessages(buildAgentContext(store.getEntries()));
// 磁盘与内存一致后，再停止后续模型请求`,
    },
    '11': {
        revision: 'workspace', files: ['src/context-budget.ts', 'src/llm-usage.ts', 'src/session/session-runtime.ts'],
        note: 'Task 11 在采集时尚未提交；这里保留当时的工作区文本，带文件 SHA-256，后续提交或修改不会改变这些快照。伪代码省略互斥与取消细节。',
        code: `// 教学伪代码：Session 层协调，不在 Loop 里压缩
const tokens = estimateContextTokens(entries, contextKey);
if (tokens !== undefined && tokens > window - reserve) {
  await autoCompact("threshold"); // Agent 空闲时
}
try {
  return await agent.prompt(text);
} catch (error) {
  if (!isContextOverflow(error)) throw error;
  if (!await compactOnce()) throw error;
  return await agent.continue(); // 不重复追加 user / 不重做已完成工具
}
// 实际 run 在成功完成后也检查 usage；恢复失败不无限重试`,
    },
};

// 修改讲解或样式时保留全部旧快照；只有显式参数才重新采集工作区。
const previous = JSON.parse(html.match(/<script id="reading-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
const refresh = process.argv.includes('--refresh-snapshots');
const resources = refresh ? {} : {...previous.resources};
const capturedAt = refresh ? new Date().toISOString() : previous.capturedAt;
for (const [id, lesson] of Object.entries(lessons)) {
    assert.ok(lessonGuides[id], '缺少章节讲解：' + id);
    lesson.guide = lessonGuides[id];
    lesson.kind = lesson.whole ? '历史源码 · 完整小文件' : lesson.excerpt ? '历史源码 · 方法摘录' : '教学伪代码 · 已省略支线，不可直接运行';
    for (const path of lesson.files) capture(path, lesson.revision);
    if (lesson.whole) lesson.code = resources[lesson.revision + ':' + lesson.whole].content.trim();
    if (lesson.excerpt) {
        const [path, from, to] = lesson.excerpt;
        const content = resources[lesson.revision + ':' + path].content;
        const start = content.indexOf(from), end = content.indexOf(to, start);
        assert.ok(start >= 0 && end > start, '摘录边界失效：' + path);
        lesson.code = content.slice(start, end).trim();
    }
}

// 只收录教学页面明确引用的源码、测试和文档；不扫描 .env 或会话数据。
const paths = new Set([...main.matchAll(/(?:src|test|docs)\/[a-zA-Z0-9_./-]+\.(?:ts|md)/g)].map(m => m[0]));
paths.add('docs/task/00-INDEX.md');
paths.add('docs/task/11-AUTO-COMPACT.md');
for (const path of paths) capture(path, 'workspace');
for (const c of chapters) assert.ok(lessons[c.id], '章节缺少内嵌代码：' + c.id);

function capture(path, revision) {
    const key = revision + ':' + path;
    if (resources[key]) return;
    assert.match(path, /^(src|test|docs)\/[\w./-]+\.(ts|md)$/);
    const content = revision === 'workspace'
        ? readFileSync(new URL('../' + path, import.meta.url), 'utf8')
        : execFileSync('git', ['show', revision + ':' + path], {cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024});
    assert.ok(!/sk-[a-zA-Z0-9_-]{20,}/.test(content), '疑似密钥，停止嵌入：' + path);
    const commit = revision === 'workspace' ? undefined
        : execFileSync('git', ['rev-parse', revision], {cwd: root, encoding: 'utf8'}).trim();
    resources[key] = {
        path, revision, content, commit, capturedAt,
        hash: createHash('sha256').update(content).digest('hex'),
        label: revision === 'workspace' ? '工作区快照 · ' + capturedAt : '历史提交 · ' + revision,
    };
}

const payload = JSON.stringify({capturedAt, lessons, resources}).replace(/</g, '\\u003c');
const marker = /(<script id="reading-data" type="application\/json">)[\s\S]*?(<\/script>)/;
assert.ok(marker.test(html), '找不到阅读数据槽');
// 此处为生成数据的机械嵌入；页面交互与样式使用 apply_patch 编辑。
const output = html.replace(marker, (_, start, end) => start + payload + end);
if (process.argv.includes('--check')) assert.equal(output, html, '讲解已变化，请运行生成脚本更新 HTML');
else writeFileSync(target, output);
console.log('Embedded ' + Object.keys(lessons).length + ' lessons / ' + Object.keys(resources).length + ' fixed snapshots.');
