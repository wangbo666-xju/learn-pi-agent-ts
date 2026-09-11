import type {UserMessage} from "./types.ts";


/** 队列只负责保存和取出消息，不决定什么时候调用模型。 */
export class MessageQueue {
    private readonly messages: UserMessage[] = [];

    enqueue(message: UserMessage): void {
        this.messages.push(structuredClone(message));
    }

    /** 一次取出全部排队消息，同时清空队列。 */
    drain(): UserMessage[] {
        return this.messages.splice(0);
    }

    clear(): void {
        this.messages.length = 0;
    }

    get size(): number {
        return this.messages.length;
    }
}