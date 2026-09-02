export type CliCommand =
    | { type: "empty" }
    | { type: "new" }
    | { type: "list" }
    | { type: "skills" }
    | {
    type: "skill";
    name: string;
    additionalInstructions?: string;
}
    | { type: "resume"; sessionId?: string }
    | { type: "help" }
    | { type: "exit" }
    | { type: "prompt"; text: string };

export function parseCliCommand(input: string): CliCommand {
    const text = input.trim();

    if (!text) {
        return {type: "empty"};
    }

    if (!text.startsWith("/")) {
        return {
            type: "prompt",
            text,
        };
    }


    const [command, ...args] = text.split(/\s+/);

    if (command.startsWith("/skill:")) {
        return {
            type: "skill",
            name: command.slice("/skill:".length),
            additionalInstructions: args.join(" ") || undefined,
        };
    }

    switch (command) {
        case "/new":
            return {type: "new"};
        case "/sessions":
            return {type: "list"};
        case "/resume":
            return {
                type: "resume",
                sessionId: args[0],
            };
        case "/help":
            return {type: "help"};
        case "/exit":
            return {type: "exit"};
        case "/skills":
            return {type: "skills"};
        default:
            // 未知 /命令 也交给模型，当作普通问题处理。
            return {
                type: "prompt",
                text,
            };
    }
}