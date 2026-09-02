import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadSkills } from "../src/skills/skill-loader.ts";
import { formatSkillsForSystemPrompt } from "../src/skills/system-prompt.ts";

test("加载 SKILL.md 的元数据和正文", async (t) => {
	const skillsRoot = await mkdtemp(join(tmpdir(), "agent-ts-skills-"));

	t.after(async () => {
		await rm(skillsRoot, { recursive: true, force: true });
	});

	const skillDir = join(skillsRoot, "java");
	await mkdir(skillDir);
	await writeFile(
		join(skillDir, "SKILL.md"),
		`---
name: java
description: 编写和审查 Java 代码时使用。
---

# Java 规则

- 修改后补充测试。
`,
		"utf8",
	);

	const skills = await loadSkills(skillsRoot);

	assert.equal(skills.length, 1);
	assert.equal(skills[0]?.name, "java");
	assert.match(skills[0]?.content ?? "", /修改后补充测试/);
});

test("System Prompt 只放 Skill 索引，不放完整正文", () => {
	const prompt = formatSkillsForSystemPrompt([
		{
			name: "java",
			description: "编写 Java 代码时使用。",
			filePath: "D:/skills/java/SKILL.md",
			content: "这里是很长的 Java 规则正文。",
			disableModelInvocation: false,
		},
	]);

	assert.match(prompt, /<name>java<\/name>/);
	assert.match(prompt, /D:\/skills\/java\/SKILL.md/);
	assert.doesNotMatch(prompt, /很长的 Java 规则正文/);
});
