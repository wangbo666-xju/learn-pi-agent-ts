import {isAbsolute, relative, resolve, sep} from "node:path";

export function resolvePath(workspaceRoot: string,
                            inputPath: string): string {

    const root = resolve(workspaceRoot);
    const target = resolve(root, inputPath);
    const relativePath = relative(root, target);

    const outsideWorkspace =
        relativePath === ".." ||
        relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath);

    if (outsideWorkspace) {
        throw new Error(`禁止访问工作区外路径：${inputPath}`);
    }

    return target;
}