import type {Skill} from "./types.ts";

/**
 * 用户执行 /skill:java <补充要求> 时调用。
 * 完整 Skill 作为本轮用户上下文进入 Agent 和 Session。
 */

export function formatSkillInvocation(
    skill: Skill,
    additionalInstructions?: string,
): string {
    const skillBlock = [
        `<skill name="${skill.name}" location="${skill.filePath}">`,
        `Skill 内相对路径以 ${skill.filePath} 所在目录为基准。`,
        "",
        skill.content,
        "</skill>",
    ].join("\n");

    return additionalInstructions
        ? `${skillBlock}\n\n${additionalInstructions}`
        : skillBlock;
}