import type {Tool, ToolArguments} from "./types.ts";

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateToolArguments(
    tool: Tool,
    input: unknown,
): ToolArguments {
    const schema = tool.parameters;
    if (schema.type !== "object") {
        throw new Error("工具 " + tool.name + " 的 parameters.type 必须是 object");
    }
    if (!isObject(input)) throw new Error("工具参数必须是 object");

    const properties = schema.properties ?? {};
    if (!isObject(properties)) throw new Error("properties 必须是 object");
    const required = schema.required ?? [];
    if (!Array.isArray(required) || required.some((name) => typeof name !== "string")) {
        throw new Error("required 必须是字符串数组");
    }

    for (const name of required) {
        if (!Object.hasOwn(input, name)) throw new Error("缺少参数：" + name);
    }
    for (const [name, property] of Object.entries(properties)) {
        if (!isObject(property) || property.type !== "string") {
            throw new Error("学习版暂不支持属性类型：" + name);
        }
        if (Object.hasOwn(input, name) && typeof input[name] !== "string") {
            throw new Error("参数 " + name + " 必须是 string");
        }
    }
    if (schema.additionalProperties === false) {
        for (const name of Object.keys(input)) {
            if (!Object.hasOwn(properties, name)) throw new Error("未知参数：" + name);
        }
    }
    return input;
}