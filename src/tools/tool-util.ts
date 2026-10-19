import {basename, dirname, isAbsolute, relative, resolve, sep} from "node:path";
import {lstat, realpath} from "node:fs/promises";

/** 词法检查之后还要检查链接的真实目标；允许工作区内的合法链接。 */
export async function resolveSafePath(workspaceRoot: string, inputPath: string): Promise<string> {
    const root = await realpath(workspaceRoot);
    // 第一层先按路径文本拦截 ../ 等越界，这时还不知道链接的真实目标。
    const target = resolvePath(root, inputPath);
    let actual: string;
    try {
        actual = await realpath(target);
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        // realpath 的 ENOENT 也可能来自悬空链接，不能把它当成可新建的普通文件。
        const stat = await lstat(target).catch((cause: unknown) => {
            if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
            throw cause;
        });
        if (stat?.isSymbolicLink()) throw new Error("禁止通过悬空链接创建文件");
        // 新文件无法解析自身，改为解析已存在父目录；这里不自动创建缺失的父目录。
        actual = resolve(await realpath(dirname(target)), basename(target));
    }
    // 第二层验证真实目标，防止项目内链接指向工作区外。
    return resolvePath(root, actual);
}

// 同步词法检查：计算相对根目录的位置，不访问磁盘。
export function resolvePath(workspaceRoot: string,
                            inputPath: string): string {

    const root = resolve(workspaceRoot);
    const target = resolve(root, inputPath);
    const relativePath = relative(root, target);

    // 跨盘符的相对结果可能仍是绝对路径，所以还要检查 isAbsolute。
    const outsideWorkspace =
        relativePath === ".." ||
        relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath);

    if (outsideWorkspace) {
        throw new Error(`禁止访问工作区外路径：${inputPath}`);
    }

    return target;
}