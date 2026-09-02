import {readdir, readFile} from "node:fs/promises";
import {join} from "node:path";
import type {Skill} from "./types.ts";


/**
 * 第一版只扫描：
 *
 * skills/
 *   └─ <skill-name>/
 *        └─ SKILL.md
 */

export async function loadSkills(
    skillsRoot: string,
): Promise<Skill[]> {
    let entries;

    try {
        entries = await readdir(skillsRoot, {
            withFileTypes: true
        })
    } catch (error) {
        const code = error instanceof Error && "code" in error
            ? error.code : undefined;
        // 没有 skills/ 目录时，代表当前项目没有 Skill，不是错误。
        if (code === "ENOENT") {
            return [];
        }

        throw error;
    }


    const skills: Skill[] = [];

    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }

        const filePath = join(skillsRoot, entry.name, "SKILL.md");

        try {
            const rawContent = await readFile(filePath, "utf-8");
            skills.push(
                parseSkillFile(filePath, rawContent),
            );
        } catch (error) {
            const code = error instanceof Error
            && "code" in error
                ? error.code
                : undefined;

            // 普通目录不是 Skill；只有含 SKILL.md 的目录才加载。
            if (code !== "ENOENT") {
                throw error;
            }
        }

    }
    return skills;

}


function parseSkillFile(
    filePath: string,
    rawContent: string,
): Skill {
    const content = rawContent.replace(/\r\n/g, "\n");

    if (!content.startsWith("---\n")) {
        throw new Error(
            `Skill 缺少 frontmatter：${filePath}`,
        );
    }

    const endIndex = content.indexOf("\n---", 4);

    if (endIndex === -1) {
        throw new Error(
            `Skill frontmatter 未结束：${filePath}`,
        );
    }

    const frontmatter = content.slice(4, endIndex);
    const body = content.slice(endIndex + 4).trim();

    const metadata = new Map<string, string>();

    for (const line of frontmatter.split("\n")) {
        const separatorIndex = line.indexOf(":");

        if (separatorIndex === -1) {
            continue;
        }

        const key = line.slice(0, separatorIndex).trim();
        const value = line
            .slice(separatorIndex + 1)
            .trim()
            .replace(/^["']|["']$/g, "");

        metadata.set(key, value);
    }

    const name = metadata.get("name");
    const description = metadata.get("description");

    if (!name || !/^[a-z0-9-]+$/.test(name)) {
        throw new Error(
            `Skill name 非法：${filePath}`,
        );
    }

    if (!description) {
        throw new Error(
            `Skill 缺少 description：${filePath}`,
        );
    }

    return {
        name,
        description,
        content: body,
        filePath,
        disableModelInvocation:
            metadata.get("disable-model-invocation") === "true",
    };
}