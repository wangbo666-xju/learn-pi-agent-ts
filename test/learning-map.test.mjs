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
    const api = new Function('readingData', engine[1] + '\nreturn {sourceLink, renderCodeLesson, renderResource, getResource, renderLessonArticle: typeof renderLessonArticle === "function" ? renderLessonArticle : undefined};')(data);
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
