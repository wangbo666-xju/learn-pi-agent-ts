import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const html = readFileSync(new URL('../docs/AGENT_LEARNING_MAP.html', import.meta.url), 'utf8');
function loadReader() {
    const payload = html.match(/<script id="reading-data" type="application\/json">([\s\S]*?)<\/script>/);
    assert.ok(payload, '页面应内嵌固定版本的阅读材料，而不是要求下载源文件');
    const engine = html.match(/<script id="reading-engine">([\s\S]*?)<\/script>/);
    assert.ok(engine, '页面应提供可独立验证的页内阅读逻辑');
    const data = JSON.parse(payload[1]);
    const api = new Function('readingData', engine[1] + '\nreturn {sourceLink, renderCodeLesson, renderResource, getResource, renderLessonArticle, renderWalkthroughFrame: typeof renderWalkthroughFrame === "function" ? renderWalkthroughFrame : undefined, createWalkthroughPlayer: typeof createWalkthroughPlayer === "function" ? createWalkthroughPlayer : undefined, renderLessonDiagram: typeof renderLessonDiagram === "function" ? renderLessonDiagram : undefined};')(data);
    return {data, ...api};
}

test('F01 打开最早提交的 Agent，而非当前双层 Loop', () => {
    const reader = loadReader();
    const lesson = reader.data.lessons.F01;
    assert.equal(lesson.revision, '27ad7e9');
    const resource = reader.getResource('src/agent.ts', lesson.revision);
    const original = execFileSync('git', ['show', '27ad7e9:src/agent.ts'], {cwd: root, encoding: 'utf8'});
    assert.equal(resource.content, original);
    const result = reader.renderCodeLesson({id: 'F01'});
    assert.match(result, /while/);
    assert.match(result, /27ad7e9/);
    assert.doesNotMatch(result, /runAgentLoop/);
});

test('源文件操作只打开页内阅读器，不产生下载链接', () => {
    const reader = loadReader();
    const result = reader.sourceLink('src/agent.ts', '查看完整代码', '27ad7e9');
    assert.match(result, /<button/);
    assert.match(result, /data-source="src\/agent.ts"/);
    assert.match(result, /data-revision="27ad7e9"/);
    assert.doesNotMatch(result, /href=|download|target=/);
});

test('23 章均可直接阅读代码；历史文件与当前对照都已嵌入', () => {
    const reader = loadReader();
    assert.equal(Object.keys(reader.data.lessons).length, 23);
    for (const [id, lesson] of Object.entries(reader.data.lessons)) {
        assert.ok(lesson.code.trim(), id);
        assert.ok(lesson.kind && lesson.note, id);
        for (const path of lesson.files) assert.ok(reader.getResource(path, lesson.revision).content, id + ':' + path);
        assert.match(reader.renderCodeLesson({id}), /<pre/);
    }
    assert.equal(reader.data.lessons['11'].revision, 'workspace');
    assert.match(reader.renderCodeLesson({id: '11'}), /工作区快照/);
});

test('阅读器按文本显示源码，源码中的 HTML 不会被执行', () => {
    const reader = loadReader();
    reader.data.resources['fixture:test.ts'] = {
        path: 'test.ts', revision: 'fixture', label: '测试快照',
        content: '<script>alert("x")</script>\nconst value = "<img src=x>";',
    };
    const result = reader.renderResource('test.ts', 'fixture');
    assert.match(result, /&lt;script&gt;/);
    assert.doesNotMatch(result, /<script>|<img/);
    assert.match(result, /data-line="2"/);
});

test('缺失历史材料会明确说明，不偷偷替换成当前源码', () => {
    const reader = loadReader();
    assert.equal(reader.getResource('src/agent-loop.ts', '27ad7e9'), undefined);
    assert.match(reader.renderResource('src/agent-loop.ts', '27ad7e9'), /未收录/);
});

test('模块、调用步骤、文档和测试入口均能读取已嵌入快照', () => {
    const reader = loadReader();
    const main = html.match(/<script id="map-app">([\s\S]*?)<\/script>/)[1];
    const paths = new Set([...main.matchAll(/(?:src|test|docs)\/[a-zA-Z0-9_./-]+\.(?:ts|md)/g)].map(m => m[0]));
    paths.add('docs/task/00-INDEX.md');
    paths.add('docs/task/11-AUTO-COMPACT.md');
    for (const path of paths) {
        assert.ok(reader.getResource(path, 'workspace')?.content, path);
        assert.doesNotMatch(reader.renderResource(path, 'workspace'), /<p class="reader-empty">/);
    }
});

test('内嵌代码含有 script 文本时也不会截断页面脚本', () => {
    const reader = loadReader();
    assert.ok(reader.data.resources['workspace:docs/task/00-INDEX.md']);
    const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 4);
    for (const [, attributes, source] of scripts) {
        if (!attributes.includes('application/json')) new Function(source);
    }
});

test('每章先给例子和结构，再给代码和总结，不再从大段源码开始', () => {
    const reader = loadReader();
    assert.equal(typeof reader.renderLessonArticle, 'function', '缺少系统性的章节阅读流程');
    const main = html.match(/<script id="map-app">([\s\S]*?)<\/script>/)[1];
    const chapters = new Function(main.slice(main.indexOf('const chapters ='), main.indexOf('const groups=')) + ';return chapters;')();
    for (const chapter of chapters) {
        const result = reader.renderLessonArticle(chapter);
        const sections = [...result.matchAll(/data-section="(example|structure|code|summary)"/g)].map(m => m[1]);
        assert.deepEqual(sections, ['example', 'structure', 'code', 'summary'], chapter.id);
        assert.doesNotMatch(result, />undefined<|\[object Object\]/, chapter.id);
        assert.match(result, /data-source=/, chapter.id);
    }
});

test('例子、图中分支和设计总结作为文本渲染，不执行其中的标签', () => {
    const reader = loadReader();
    assert.equal(typeof reader.renderLessonArticle, 'function');
    const lesson = reader.data.lessons.F01;
    lesson.guide.input = '<img src=x onerror=alert(1)>';
    lesson.guide.branch = '<script>unsafe</script>';
    lesson.guide.why = '<b>不是 HTML</b>';
    const result = reader.renderLessonArticle({id:'F01'});
    assert.match(result, /&lt;img/);
    assert.match(result, /&lt;script&gt;/);
    assert.match(result, /&lt;b&gt;/);
    assert.doesNotMatch(result, /<img|<script>|<b>不是 HTML/);
});

test('历史与工作区快照仍和生成时的 SHA-256 一致', () => {
    const {data} = loadReader();
    for (const resource of Object.values(data.resources)) {
        assert.equal(createHash('sha256').update(resource.content).digest('hex'), resource.hash, resource.path);
    }
});

test('F01 分步演示把一次 read 的结果带进第二次请求，而非重复用户输入', () => {
    const reader = loadReader();
    const demo = reader.data.lessons.F01.guide.walkthrough;
    assert.ok(demo, '缺少 F01 数据推演');
    assert.equal(demo.steps.length, 7);
    const first = demo.steps[1], second = demo.steps[5], final = demo.steps[6];
    assert.deepEqual(first.requestMessages, [{role: 'user', content: '读取 README.md，然后用一句话总结。'}]);
    assert.deepEqual(second.requestMessages, [
        {role: 'user', content: '读取 README.md，然后用一句话总结。'},
        {role: 'assistant', content: '我先读取文件。', toolCalls: [{id: 'c1', name: 'read', arguments: {path: 'README.md'}}]},
        {role: 'toolResult', toolCallId: 'c1', content: '这是一个使用 TypeScript 编写的命令行 Agent。'},
    ]);
    assert.equal(demo.steps[3].messages.length, 2, '读取完成不等于结果已追加');
    assert.deepEqual(final.messages.map(message => message.role), ['user', 'assistant', 'toolResult', 'assistant']);
    assert.equal(final.modelCalls, 2);
    assert.equal(final.toolExecutions, 1);
    assert.equal(first.modelCalls, 1);
    assert.equal(first.toolExecutions, 0);
    assert.equal(typeof reader.renderWalkthroughFrame, 'function');
    const before = JSON.stringify(demo);
    const result = reader.renderWalkthroughFrame('F01', 5);
    assert.match(result, /toolCallId/);
    assert.match(result, /c1/);
    assert.match(result, /data-active-node="model"/);
    reader.renderWalkthroughFrame('F01', 1);
    assert.equal(JSON.stringify(demo), before, '翻页不能改变帧中的消息');
    assert.equal(reader.renderWalkthroughFrame('F02', 0), '');
});

test('演示消息和代码中的 HTML 只作为文本显示', () => {
    const reader = loadReader();
    assert.equal(typeof reader.renderWalkthroughFrame, 'function');
    const frame = reader.data.lessons.F01.guide.walkthrough.steps[0];
    frame.code = '<script>bad()</script>';
    frame.messages[0].content = '<img src=x onerror=bad()>';
    frame.explanation = '<svg onload=bad()>';
    const result = reader.renderWalkthroughFrame('F01', 0);
    assert.match(result, /&lt;script&gt;/);
    assert.match(result, /&lt;img/);
    assert.match(result, /&lt;svg/);
    assert.doesNotMatch(result, /<script|<img|<svg/);
});

test('新增讲解不重新采集 119 份历史和工作区资源', () => {
    const {data} = loadReader();
    assert.equal(Object.keys(data.resources).length, 119);
    assert.equal(createHash('sha256').update(JSON.stringify(data.resources)).digest('hex'),
        '154f7805d1067bdf652deb2dabd0e152ea704281675ebcbe30f31f928e895ed6');
});

function playerFixture() {
    const {createWalkthroughPlayer} = loadReader();
    assert.equal(typeof createWalkthroughPlayer, 'function', '需要真实的播放控制器');
    const scheduled = new Map();
    let id = 0;
    const changes = [];
    const player = createWalkthroughPlayer({stepCount: 7,
        onChange: state => changes.push(state),
        schedule: (callback, delay) => { assert.equal(delay, 2500); scheduled.set(++id, callback); return id; },
        cancel: handle => scheduled.delete(handle),
    });
    return {player, changes, tick: () => { for (const callback of [...scheduled.values()]) callback(); },
        queued: () => [...scheduled.values()]};
}

test('播放器按七帧推进，播放重复点击不加速，到末尾停止并可重播', () => {
    const {player, tick, changes} = playerFixture();
    assert.deepEqual(player.getState(), {index: 0, playing: false});
    player.dispatch('previous');
    assert.equal(player.getState().index, 0);
    player.dispatch('play'); player.dispatch('play');
    tick();
    assert.deepEqual(player.getState(), {index: 1, playing: true});
    for (let i = 0; i < 10; i++) tick();
    assert.deepEqual(player.getState(), {index: 6, playing: false});
    player.dispatch('next');
    assert.equal(player.getState().index, 6);
    player.dispatch('play');
    assert.deepEqual(player.getState(), {index: 0, playing: true});
    tick(); player.dispatch('pause'); tick();
    assert.deepEqual(player.getState(), {index: 1, playing: false});
    player.dispatch('next');
    assert.deepEqual(player.getState(), {index: 2, playing: false});
    assert.deepEqual(changes.at(-1), {index: 2, playing: false});
    const external = player.getState(); external.index = 100;
    assert.equal(player.getState().index, 2);
});

test('重置、单步与销毁都停止计时，过期回调不能继续改变画面', () => {
    const {player, tick, queued, changes} = playerFixture();
    player.dispatch('play');
    const stale = queued()[0];
    tick(); player.dispatch('reset');
    stale(); tick();
    assert.deepEqual(player.getState(), {index: 0, playing: false});
    player.dispatch('play');
    stale();
    assert.deepEqual(player.getState(), {index: 0, playing: true}, '前一次播放遗留回调必须失效');
    player.dispatch('next'); tick();
    assert.deepEqual(player.getState(), {index: 1, playing: false});
    player.dispatch('play');
    const afterDispose = queued()[0];
    player.dispose();
    const count = changes.length;
    afterDispose(); player.dispatch('play'); tick();
    assert.equal(changes.length, count);
    assert.deepEqual(player.getState(), {index: 1, playing: false});
});

test('06 与 09 图解能显示分开的泳道，其他章节不凭空添加图', () => {
    const reader = loadReader();
    assert.equal(typeof reader.renderLessonDiagram, 'function');
    assert.equal(reader.renderLessonDiagram('F02'), '');
    for (const id of ['06', '09']) {
        const diagram = reader.data.lessons[id].guide.diagram;
        assert.ok(diagram);
        const result = reader.renderLessonDiagram(id);
        assert.equal([...result.matchAll(/class="diagram-lane"/g)].length, 2);
        for (const lane of diagram.lanes) {
            assert.ok(result.includes(lane.title));
            for (const step of lane.steps) assert.ok(result.includes(step.label));
        }
        assert.ok(reader.renderLessonArticle({id}).includes(result));
    }
});

test('图解和深入讲解数据中的标签不能变成可执行元素', () => {
    const reader = loadReader();
    assert.equal(typeof reader.renderLessonDiagram, 'function');
    const diagram = reader.data.lessons['06'].guide.diagram;
    diagram.lanes[0].steps[0].label = '<img src=x onerror=bad()>';
    diagram.note = '<script>bad()</script>';
    reader.data.lessons.F01.guide.reasoning.why = '<svg onload=bad()>';
    const result = reader.renderLessonDiagram('06') + reader.renderLessonArticle({id: 'F01'});
    assert.match(result, /&lt;img/);
    assert.match(result, /&lt;script&gt;/);
    assert.match(result, /&lt;svg/);
    assert.doesNotMatch(result, /<img|<script|<svg/);
});

test('调用连线明确来源和接收者，纵向布局不复用左右箭头文案', () => {
    const reader = loadReader();
    for (const [index, from, to, label] of [
        [1, 'loop', 'model', '请求模型'],
        [2, 'model', 'loop', '返回回复'],
        [3, 'loop', 'tool', '调用工具'],
        [4, 'tool', 'loop', '返回结果'],
    ]) {
        const result = reader.renderWalkthroughFrame('F01', index);
        const active = result.match(/<div class="wt-link active"[^>]*>[\s\S]*?<\/div>/)?.[0];
        assert.ok(active);
        assert.doesNotMatch(active, /←|→/);
        assert.ok(active.includes('data-from="' + from + '"'));
        assert.ok(active.includes('data-to="' + to + '"'));
        assert.ok(active.includes(label));
    }
});
