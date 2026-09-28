import fs from "node:fs";
export const STYLE_MANIFEST_VERSION = 1;
/** Read a page's `styles.json`, or null when the capture has none. */
export function readStyleManifest(file) {
    try {
        const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
        return manifest.version === STYLE_MANIFEST_VERSION ? manifest : null;
    }
    catch {
        return null;
    }
}
/** Write a page's `styles.json`, compactly: it's large and read by tools, not people. */
export function writeStyleManifest(file, manifest) {
    fs.writeFileSync(file, `${JSON.stringify(manifest)}\n`, "utf8");
}
/** Properties that inherit by default. Custom properties always do. */
export const INHERITED = new Set([
    "color",
    "cursor",
    "direction",
    "font-family",
    "font-size",
    "font-style",
    "font-variant",
    "font-weight",
    "letter-spacing",
    "line-height",
    "list-style-position",
    "list-style-type",
    "text-align",
    "text-indent",
    "text-shadow",
    "text-transform",
    "visibility",
    "white-space",
    "word-spacing",
]);
/**
 * Tracked by default: longhands that paint or lay out an element. Width and
 * height only count when a declaration sets them (see `correlate.ts`),
 * since otherwise they're a result of layout, not a cause.
 */
export const DEFAULT_TRACKED_PROPERTIES = [
    "display",
    "position",
    "top",
    "right",
    "bottom",
    "left",
    "z-index",
    "width",
    "height",
    "min-width",
    "min-height",
    "max-width",
    "max-height",
    "margin-top",
    "margin-right",
    "margin-bottom",
    "margin-left",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "border-top-width",
    "border-right-width",
    "border-bottom-width",
    "border-left-width",
    "border-top-style",
    "border-right-style",
    "border-bottom-style",
    "border-left-style",
    "border-top-color",
    "border-right-color",
    "border-bottom-color",
    "border-left-color",
    "border-top-left-radius",
    "border-top-right-radius",
    "border-bottom-right-radius",
    "border-bottom-left-radius",
    "flex-direction",
    "flex-wrap",
    "flex-grow",
    "flex-shrink",
    "flex-basis",
    "justify-content",
    "align-items",
    "align-self",
    "row-gap",
    "column-gap",
    "grid-template-columns",
    "grid-template-rows",
    "color",
    "background-color",
    "background-image",
    "font-family",
    "font-size",
    "font-style",
    "font-weight",
    "line-height",
    "letter-spacing",
    "text-align",
    "text-decoration-line",
    "text-transform",
    "white-space",
    "opacity",
    "transform",
    "box-shadow",
    "outline-style",
    "outline-width",
    "outline-color",
    "overflow-x",
    "overflow-y",
];
