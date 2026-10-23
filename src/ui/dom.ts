/**
 * Builds DOM from text only. A string child becomes a text node, so user text never reaches an HTML parser.
 * Event handlers are attached with addEventListener, never through attributes.
 */

export type Child = Node | string;

export interface ElementOptions {
	readonly className?: string;
	readonly attrs?: Readonly<Record<string, string>>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	options: ElementOptions = {},
	...children: Child[]
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (options.className) node.className = options.className;
	for (const [name, value] of Object.entries(options.attrs ?? {})) {
		if (/^on/i.test(name))
			throw new Error(`event handler attribute ${name} is not allowed`);
		node.setAttribute(name, value);
	}
	node.append(...children);
	return node;
}

export function button(
	label: string,
	onClick: () => void,
	options: ElementOptions = {},
): HTMLButtonElement {
	const node = el("button", {
		...options,
		attrs: { type: "button", ...options.attrs },
	});
	node.textContent = label;
	node.addEventListener("click", onClick);
	return node;
}

export async function copyToClipboard(text: string): Promise<string> {
	if (!navigator.clipboard) {
		return "Clipboard access is unavailable.";
	}
	try {
		await navigator.clipboard.writeText(text);
		return "Copied.";
	} catch (error) {
		if (!(error instanceof DOMException)) throw error;
		return "Could not copy the link. Allow clipboard access and try again.";
	}
}
