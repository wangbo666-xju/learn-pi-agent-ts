
import assert from "node:assert/strict";
import test from "node:test";
import {AgentEventBus} from "../src/agent-events.ts";

test("事件监听器按照注册顺序执行并等待异步监听器", async () => {
    const calls: string[] = [];
    const eventBus = new AgentEventBus();

    eventBus.subscribe(async () => {
        calls.push("first:start");
        await Promise.resolve();
        calls.push("first:end");
    });

    eventBus.subscribe(() => {
        calls.push("second");
    });

    await eventBus.emit({
        type: "agent_start",
    });

    assert.deepEqual(calls, [
        "first:start",
        "first:end",
        "second",
    ]);
});

test("取消订阅后不再接收事件", async () => {
    let receivedCount = 0;
    const eventBus = new AgentEventBus();

    const unsubscribe = eventBus.subscribe(() => {
        receivedCount++;
    });

    await eventBus.emit({
        type: "agent_start",
    });

    unsubscribe();

    await eventBus.emit({
        type: "agent_start",
    });

    assert.equal(receivedCount, 1);
});