import type {Skill} from "./types.ts";

/**
 * 只告诉模型有哪些 Skill，不注入完整正文。
 * 模型匹配任务后，应使用 read 工具读取对应 SKILL.md。
 */

export function formatSkillsForSystemPrompt(
    skills: Skill[],
): string {
    const visibleSkills = skills.filter(
        (skill) => !skill.disableModelInvocation,
    );

    if (visibleSkills.length === 0) {
        return "";
    }

    const lines = [
        "以下是可用的专业 Skill。",
        "当用户任务与 Skill description 匹配时，使用 read 工具读取完整 SKILL.md 后再执行。",
        "",
        "<available_skills>",
    ];

    for (const skill of visibleSkills) {
        lines.push("  <skill>");
        lines.push(`    <name>${escapeXml(skill.name)}</name>`);
        lines.push(
            `    <description>${escapeXml(skill.description)}</description>`,
        );
        lines.push(
            `    <location>${escapeXml(skill.filePath)}</location>`,
        );
        lines.push("  </skill>");
    }

    lines.push("</available_skills>");

    return lines.join("\n");

}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}