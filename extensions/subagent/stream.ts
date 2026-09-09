import { StringDecoder } from "node:string_decoder";

export interface JsonlOverflow {
	maxBytes: number;
	bytes: number;
}

export interface BoundedJsonlReaderOptions {
	maxLineBytes: number;
	onLine: (line: string) => void;
	onOverflow: (overflow: JsonlOverflow) => void;
}

/** Incrementally decodes UTF-8 JSONL without retaining an unbounded line. */
export class BoundedJsonlReader {
	private readonly decoder = new StringDecoder("utf8");
	private readonly maxLineBytes: number;
	private readonly onLine: (line: string) => void;
	private readonly onOverflow: (overflow: JsonlOverflow) => void;
	private line = "";
	private lineBytes = 0;
	private dropping = false;
	private ended = false;

	constructor(options: BoundedJsonlReaderOptions) {
		if (!Number.isSafeInteger(options.maxLineBytes) || options.maxLineBytes <= 0) {
			throw new Error("maxLineBytes must be a positive safe integer");
		}
		this.maxLineBytes = options.maxLineBytes;
		this.onLine = options.onLine;
		this.onOverflow = options.onOverflow;
	}

	push(chunk: Uint8Array): void {
		if (this.ended) throw new Error("Cannot push to an ended JSONL reader");
		this.consume(this.decoder.write(Buffer.from(chunk)));
	}

	end(): void {
		if (this.ended) return;
		this.ended = true;
		this.consume(this.decoder.end());
		if (!this.dropping && this.line) this.onLine(this.line);
		this.resetLine();
	}

	private consume(text: string): void {
		let offset = 0;
		while (offset < text.length) {
			const newline = text.indexOf("\n", offset);
			const end = newline === -1 ? text.length : newline;
			const segment = text.slice(offset, end);
			this.consumeSegment(segment);
			if (newline === -1) return;
			if (!this.dropping) this.onLine(this.line);
			this.resetLine();
			offset = newline + 1;
		}
	}

	private consumeSegment(segment: string): void {
		if (this.dropping) return;
		const segmentBytes = Buffer.byteLength(segment, "utf8");
		const nextBytes = this.lineBytes + segmentBytes;
		if (nextBytes > this.maxLineBytes) {
			this.dropping = true;
			this.line = "";
			this.lineBytes = this.maxLineBytes + 1;
			this.onOverflow({ maxBytes: this.maxLineBytes, bytes: nextBytes });
			return;
		}
		this.line += segment;
		this.lineBytes = nextBytes;
	}

	private resetLine(): void {
		this.line = "";
		this.lineBytes = 0;
		this.dropping = false;
	}
}

export class RollingMessageBuffer<T> {
	readonly items: T[] = [];
	private readonly itemBytes: number[] = [];
	private totalBytes = 0;
	private readonly maxItems: number;
	private readonly maxBytes: number;

	constructor(maxItems: number, maxBytes: number) {
		if (!Number.isSafeInteger(maxItems) || maxItems <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
			throw new Error("Rolling message limits must be positive safe integers");
		}
		this.maxItems = maxItems;
		this.maxBytes = maxBytes;
	}

	append(value: T, bytes: number): boolean {
		if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maxBytes) return false;
		while (this.items.length >= this.maxItems || this.totalBytes + bytes > this.maxBytes) {
			this.items.shift();
			this.totalBytes -= this.itemBytes.shift() ?? 0;
		}
		this.items.push(value);
		this.itemBytes.push(bytes);
		this.totalBytes += bytes;
		return true;
	}

	get byteSize(): number {
		return this.totalBytes;
	}
}

export function messageUsesTools(message: { role?: unknown; content?: unknown }): boolean {
	if (message.role === "toolResult") return true;
	return message.role === "assistant" && Array.isArray(message.content)
		&& message.content.some((part: any) => part?.type === "toolCall");
}

export function getLatestAssistantText(messages: ReadonlyArray<{ role?: unknown; content?: unknown }>): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		if (typeof message.content === "string") return message.content;
		if (Array.isArray(message.content)) {
			const textParts = message.content.filter((part: any) => part?.type === "text" && typeof part.text === "string");
			if (textParts.length > 0) return textParts.map((part: any) => part.text).join("");
		}
	}
	return "";
}
