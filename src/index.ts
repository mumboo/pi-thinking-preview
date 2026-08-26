import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, Spacer, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const INTERNAL_ASSISTANT_MESSAGE = "dist/modes/interactive/components/assistant-message.js";
const INTERNAL_THEME = "dist/modes/interactive/theme/theme.js";
const INTERNAL_MARKDOWN_TRANSFORM = "dist/modes/interactive/components/markdown-transform.js";

interface AssistantContentItem {
    type: string;
    text?: string;
    thinking?: string;
}

interface AssistantMessageLike {
    content: AssistantContentItem[];
    stopReason?: string;
    errorMessage?: string;
}

interface ThemeLike {
    fg(color: string, text: string): string;
    italic(text: string): string;
}

type MarkdownTransform = (text: string) => string;

interface MarkdownTransformFactory {
    (kind: string, isStreaming: boolean, transformers: unknown[]): MarkdownTransform;
}

interface AssistantMessageComponentInstance {
    lastMessage?: unknown;
    isStreaming: boolean;
    hasToolCalls: boolean;
    hideThinkingBlock: boolean;
    markdownTheme: unknown;
    outputPad: number;
    markdownTransformers: unknown[];
    contentContainer: { clear(): void; addChild(component: unknown): void };
    updateContent(message: AssistantMessageLike, isStreaming?: boolean): void;
}

interface AssistantMessageComponentPrototype {
    updateContent: AssistantMessageComponentInstance["updateContent"];
}

class ThinkingPreviewLine implements Component {
    constructor(private readonly text: string, private readonly paddingX: number) {}

    render(width: number): string[] {
        const contentWidth = Math.max(1, width - this.paddingX * 2);
        const margin = " ".repeat(this.paddingX);
        return [margin + truncateToWidth(this.text, contentWidth, "…")];
    }

    invalidate(): void {}
}

function resolvePackageEntry(packageName: string): string {
    try {
        return fileURLToPath(import.meta.resolve(packageName));
    } catch {
        return createRequire(import.meta.url).resolve(packageName);
    }
}

function importInternalModule<T>(relativePath: string): Promise<T> {
    const packageRoot = dirname(dirname(resolvePackageEntry("@earendil-works/pi-coding-agent")));
    return import(pathToFileURL(join(packageRoot, relativePath)).href) as Promise<T>;
}

let originalUpdateContent: AssistantMessageComponentInstance["updateContent"] | undefined;
let patchedPrototype: AssistantMessageComponentPrototype | undefined;
let patchedUpdateContent: AssistantMessageComponentInstance["updateContent"] | undefined;

async function installPatch(): Promise<void> {
    const [{ AssistantMessageComponent }, { theme }, { createMarkdownTransform }] = await Promise.all([
        importInternalModule<{ AssistantMessageComponent: unknown }>(INTERNAL_ASSISTANT_MESSAGE),
        importInternalModule<{ theme: ThemeLike }>(INTERNAL_THEME),
        importInternalModule<{ createMarkdownTransform: MarkdownTransformFactory }>(INTERNAL_MARKDOWN_TRANSFORM),
    ]);

    const candidate = (AssistantMessageComponent as { prototype?: unknown }).prototype;
    if (!candidate || typeof (candidate as AssistantMessageComponentPrototype).updateContent !== "function") {
        throw new Error("AssistantMessageComponent prototype is incompatible with this version of pi.");
    }

    originalUpdateContent = (candidate as AssistantMessageComponentPrototype).updateContent;

    patchedUpdateContent = function patchedUpdateContent(
        this: AssistantMessageComponentInstance,
        message: AssistantMessageLike,
        isStreaming: boolean = this.isStreaming,
    ): void {
        const fallback = (): void => {
            originalUpdateContent?.call(this, message, isStreaming);
        };

        if (!this.contentContainer || typeof this.contentContainer.clear !== "function" || typeof this.contentContainer.addChild !== "function") {
            fallback();
            return;
        }

        try {
            this.lastMessage = message;
            this.isStreaming = isStreaming;
            this.contentContainer.clear();

            const hasVisibleText = (item: AssistantContentItem): boolean =>
                (item.type === "text" && Boolean(item.text?.trim())) || (item.type === "thinking" && Boolean(item.thinking?.trim()));

            if (message.content.some(hasVisibleText)) {
                this.contentContainer.addChild(new Spacer(1));
            }

            for (let index = 0; index < message.content.length; index += 1) {
                const content = message.content[index]!;
                if (content.type === "text" && content.text?.trim()) {
                    this.contentContainer.addChild(
                        new Markdown(content.text.trim(), this.outputPad, 0, this.markdownTheme as never, undefined, {
                            transform: createMarkdownTransform("assistant", this.isStreaming, this.markdownTransformers),
                        }),
                    );
                    continue;
                }

                if (content.type !== "thinking") {
                    continue;
                }

                const thinkingBlocks: string[] = [];
                for (; index < message.content.length; index += 1) {
                    const thinkingContent = message.content[index]!;
                    if (thinkingContent.type !== "thinking") break;
                    const thinking = thinkingContent.thinking?.trim();
                    if (thinking) thinkingBlocks.push(thinking);
                }
                index -= 1;

                if (thinkingBlocks.length === 0) continue;

                const hasVisibleContentAfter = message.content.slice(index + 1).some(hasVisibleText);

                if (this.hideThinkingBlock) {
                    for (const block of thinkingBlocks) {
                        const flattened = block.replace(/\s+/g, " ").trim();
                        this.contentContainer.addChild(
                            new ThinkingPreviewLine(theme.italic(theme.fg("thinkingText", flattened)), this.outputPad),
                        );
                    }
                } else {
                    this.contentContainer.addChild(
                        new Markdown(
                            thinkingBlocks.join("\n\n"),
                            this.outputPad,
                            0,
                            this.markdownTheme as never,
                            {
                                color: (text: string) => theme.fg("thinkingText", text),
                                italic: true,
                            },
                            {
                                transform: createMarkdownTransform("assistant-thinking", this.isStreaming, this.markdownTransformers),
                            },
                        ),
                    );
                }

                if (hasVisibleContentAfter) {
                    this.contentContainer.addChild(new Spacer(1));
                }
            }

            const hasToolCalls = message.content.some((item) => item.type === "toolCall");
            this.hasToolCalls = hasToolCalls;

            if (message.stopReason === "length") {
                this.contentContainer.addChild(new Spacer(1));
                this.contentContainer.addChild(new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0));
            } else if (!hasToolCalls) {
                if (message.stopReason === "aborted") {
                    const abortMessage =
                        message.errorMessage && message.errorMessage !== "Request was aborted" ? message.errorMessage : "Operation aborted";
                    this.contentContainer.addChild(new Spacer(1));
                    this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
                } else if (message.stopReason === "error") {
                    const errorMessage = message.errorMessage || "Unknown error";
                    this.contentContainer.addChild(new Spacer(1));
                    this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMessage}`), this.outputPad, 0));
                }
            }
        } catch {
            fallback();
        }
    };

    (candidate as AssistantMessageComponentPrototype).updateContent = patchedUpdateContent;
    patchedPrototype = candidate as AssistantMessageComponentPrototype;
}

function releasePatch(): void {
    if (!patchedPrototype || !originalUpdateContent || !patchedUpdateContent) return;
    if (patchedPrototype.updateContent === patchedUpdateContent) {
        patchedPrototype.updateContent = originalUpdateContent;
    }
    patchedPrototype = undefined;
    originalUpdateContent = undefined;
    patchedUpdateContent = undefined;
}

export default function (pi: ExtensionAPI) {
    pi.on("session_start", async (_event, ctx) => {
        if (ctx.mode !== "tui" || patchedPrototype) return;
        try {
            await installPatch();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const warning = `thinking-preview: ${message} Using the default thinking labels.`;
            if (ctx.hasUI) {
                ctx.ui.notify(warning, "warning");
            } else {
                console.warn(warning);
            }
        }
    });

    pi.on("session_shutdown", () => {
        releasePatch();
    });
}
