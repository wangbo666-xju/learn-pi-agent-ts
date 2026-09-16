import assert from "node:assert/strict";
import test from "node:test";
import {MessageQueue} from "../src/message-queue.ts";

test("队列复制输入，drain 按顺序返回并清空", () => {
    const queue = new MessageQueue();
    const first = {role: "user" as const, content: "one"};
    queue.enqueue(first);
    first.content = "被外部修改";
    queue.enqueue({role: "user", content: "two"});

    assert.equal(queue.size, 2);
    assert.deepEqual(queue.drain(), [
        {role: "user", content: "one"},
        {role: "user", content: "two"},
    ]);
    assert.equal(queue.size, 0);
    assert.deepEqual(queue.drain(), []);
});

test("clear 删除待处理消息", () => {
    const queue = new MessageQueue();
    queue.enqueue({role: "user", content: "one"});
    queue.clear();
    assert.deepEqual(queue.drain(), []);
});
