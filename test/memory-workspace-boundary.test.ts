import assert from "node:assert/strict";
import {mkdtemp, mkdir, readdir, realpath, rm, symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test, {type TestContext} from "node:test";
import {createMemoryWorkspace} from "../src/memory/memory-workspace.ts";

async function fixture(t: TestContext) {
    const temporary = await mkdtemp(join(tmpdir(), "memory-boundary-"));
    // 只清理本测试独立创建的目录，不访问真实项目和记忆目录。
    t.after(() => rm(temporary, {recursive: true, force: true}));
    const project = join(temporary, "project");
    await mkdir(project);
    return {temporary, project};
}

test("项目内数据目录被拒绝，拒绝前不创建任何子目录", async (t) => {
    const {project} = await fixture(t);
    await assert.rejects(createMemoryWorkspace({
        workspaceRoot: project,
        dataRoot: join(project, "new-data", "nested"),
    }), /Memory.*工作区/);
    assert.deepEqual(await readdir(project), []);
});

test("不能直接把工作区根目录作为 Memory 数据目录", async (t) => {
    const {project} = await fixture(t);
    await assert.rejects(createMemoryWorkspace({
        workspaceRoot: project, dataRoot: project,
    }), /Memory.*工作区/);
    assert.deepEqual(await readdir(project), []);
});

test("外部路径经目录链接指向工作区时，在创建缺失目录前拒绝", async (t) => {
    const {temporary, project} = await fixture(t);
    const alias = join(temporary, "external-alias");
    try {
        await symlink(project, alias, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
        if (error instanceof Error && "code" in error &&
            (error.code === "EPERM" || error.code === "EACCES")) {
            t.skip("当前环境没有创建目录链接的权限");
            return;
        }
        throw error;
    }
    await assert.rejects(createMemoryWorkspace({
        workspaceRoot: project, dataRoot: join(alias, "new-data", "nested"),
    }), /Memory.*工作区/);
    assert.deepEqual(await readdir(project), []);
});

test("工作区本身使用目录别名时，也按真实目录拒绝内部存储", async (t) => {
    const {temporary, project} = await fixture(t);
    const alias = join(temporary, "project-alias");
    try {
        await symlink(project, alias, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
        if (error instanceof Error && "code" in error &&
            (error.code === "EPERM" || error.code === "EACCES")) {
            t.skip("当前环境没有创建目录链接的权限");
            return;
        }
        throw error;
    }
    await assert.rejects(createMemoryWorkspace({
        workspaceRoot: alias, dataRoot: join(project, "new-data"),
    }), /Memory.*工作区/);
    assert.deepEqual(await readdir(project), []);
});

test("相似前缀的外部兄弟目录仍允许创建并写入索引", async (t) => {
    const {temporary, project} = await fixture(t);
    const dataRoot = join(temporary, "project-memories", "nested");
    const workspace = await createMemoryWorkspace({workspaceRoot: project, dataRoot});
    await workspace.write("MEMORY.md", "");
    assert.equal(await workspace.readIndex(), "");
    assert.equal(workspace.root, await realpath(workspace.root));
    assert.deepEqual(await readdir(project), []);
});
