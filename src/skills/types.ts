export type Skill = {
    name: string;
    description: string;

    // SKILL.md 的完整正文；自动模式下不会直接发给模型。
    content: string;

    // 模型需要完整规则时，用 read 工具读取这个路径。
    filePath: string;

    // true：只允许用户用 /skill:<name> 显式调用。
    disableModelInvocation: boolean;
};