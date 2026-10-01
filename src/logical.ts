/**
 * Logical CSS properties (`padding-inline-start`, `inset-block-end`,
 * `inline-size`, ...) and the physical ones they share a value with.
 *
 * Per CSS Logical Properties, a logical longhand and the physical longhand it
 * maps to are one property for the cascade: whichever is declared last (by
 * the usual order and specificity rules) sets both. Which physical side a
 * logical one maps to depends on the element's own computed `writing-mode`
 * and `direction`.
 */

/** The element's writing mode and direction, as `getComputedStyle` reports them. */
export interface Flow {
	writingMode?: string;
	direction?: string;
}

/** Computed properties the capture records so logical properties can be mapped. */
export const FLOW_PROPERTIES = ["writing-mode", "direction"];

type Side = "top" | "right" | "bottom" | "left";

interface Sides {
	"block-start": Side;
	"block-end": Side;
	"inline-start": Side;
	"inline-end": Side;
	/** Inline axis runs top to bottom (or bottom to top). */
	vertical: boolean;
}

/** Legacy SVG writing-mode values, as browsers alias them. */
const LEGACY: Record<string, string> = {
	lr: "horizontal-tb",
	"lr-tb": "horizontal-tb",
	rl: "horizontal-tb",
	"rl-tb": "horizontal-tb",
	tb: "vertical-rl",
	"tb-rl": "vertical-rl",
	"tb-lr": "vertical-lr",
};

function sidesOf(flow: Flow): Sides {
	const raw = (flow.writingMode ?? "").trim().toLowerCase();
	const mode = LEGACY[raw] ?? raw;
	const rtl = (flow.direction ?? "").trim().toLowerCase() === "rtl";
	const inline = (start: Side, end: Side) => (rtl ? { "inline-start": end, "inline-end": start } : { "inline-start": start, "inline-end": end });
	switch (mode) {
		case "vertical-rl":
		case "sideways-rl":
			return { "block-start": "right", "block-end": "left", ...inline("top", "bottom"), vertical: true };
		case "vertical-lr":
			return { "block-start": "left", "block-end": "right", ...inline("top", "bottom"), vertical: true };
		case "sideways-lr":
			return { "block-start": "left", "block-end": "right", ...inline("bottom", "top"), vertical: true };
		default:
			return { "block-start": "top", "block-end": "bottom", ...inline("left", "right"), vertical: false };
	}
}

const BOX = /^(margin|padding|inset|border)-(block|inline)-(start|end)(?:-(width|style|color))?$/;
const CORNER = /^border-(start|end)-(start|end)-radius$/;
const SIZE = /^(min-|max-)?(inline|block)-size$/;

/**
 * The physical longhand a logical longhand maps to for `flow`, or null when
 * `name` isn't a logical longhand (physical properties and shorthands).
 */
export function physicalName(name: string, flow: Flow): string | null {
	const box = BOX.exec(name);
	if (box) {
		const [, kind, axis, edge, part] = box;
		const side = sidesOf(flow)[`${axis}-${edge}` as keyof Omit<Sides, "vertical">];
		if (kind === "border") return part ? `border-${side}-${part}` : null;
		if (part) return null;
		return kind === "inset" ? side : `${kind}-${side}`;
	}
	const corner = CORNER.exec(name);
	if (corner) {
		const sides = sidesOf(flow);
		const block = sides[`block-${corner[1]}` as "block-start" | "block-end"];
		const inline = sides[`inline-${corner[2]}` as "inline-start" | "inline-end"];
		const [v, h] = block === "top" || block === "bottom" ? [block, inline] : [inline, block];
		return `border-${v}-${h}-radius`;
	}
	const size = SIZE.exec(name);
	if (size) {
		const vertical = sidesOf(flow).vertical;
		const dim = (size[2] === "inline") !== vertical ? "width" : "height";
		return `${size[1] ?? ""}${dim}`;
	}
	return null;
}
