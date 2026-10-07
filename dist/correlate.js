import path from "node:path";
import { IMAGES_VERSION, STYLE_MANIFEST } from "./elements.js";
import { publicDir } from "./fileroutes.js";
import { changedLines, isGitRepo, repoPrefix, topLevel } from "./git.js";
import { imageFiles, imageName } from "./imagesource.js";
import { realpath } from "./reactsource.js";
import { LineMapper } from "./remap.js";
import { readMeta, versionRev } from "./versions.js";
import { versionDir } from "./paths.js";
import { pickRepresentative } from "./representative.js";
import { readStyleManifest } from "./styles.js";
const VISUAL = new Set(["changed", "size-mismatch"]);
const STYLESHEET = /\.(css|scss|sass|less|styl|pcss|postcss)$/i;
export const LAYOUT_PROPERTIES = new Set(["width", "height", "min-width", "min-height", "max-width", "max-height"]);
/** Words too common to say which line some copy came from, unless nothing else changed. */
const STOP_WORDS = new Set(["the", "and", "for", "you", "your", "are", "with", "this", "that", "from", "our", "was", "has", "have", "its"]);
/** More changed lines than this containing an element's new copy or class is a coincidence, not a cause. */
const MAX_MATCHING_LINES = 5;
/** Changed pixels this close to an image's box (CSS pixels) still count as inside it. */
const IMAGE_TOLERANCE = 2;
/** A cause's location as people read it: `path:line`, or just `path` for a changed binary file. */
export function causeLocation(c) {
    return c.line === undefined ? c.path : `${c.path}:${c.line}`;
}
function walk(nodes, visit, parent = null) {
    nodes.forEach((n, i) => {
        visit(n, parent, i > 0 ? nodes[i - 1] : null);
        walk(n.children, visit, n);
    });
}
function declText(rule, ref) {
    const d = rule.decls[ref[1]];
    return `${rule.selector} { ${d.name}: ${d.value}${d.important ? " !important" : ""} }`;
}
/** The words of `text`, lowercased: runs of letters and digits. */
function words(text) {
    return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}
/** The words of `to` that `from` doesn't have as many of. */
function gained(from, to) {
    const left = new Map();
    for (const w of from)
        left.set(w, (left.get(w) ?? 0) + 1);
    const out = new Set();
    for (const w of to) {
        const n = left.get(w) ?? 0;
        if (n > 0)
            left.set(w, n - 1);
        else
            out.add(w);
    }
    return [...out];
}
/** The tokens of a line of source that could be class names: runs between whitespace and quotes. */
function tokens(text) {
    return text.split(/[\s"'`]+/).filter(Boolean);
}
/** `\:` to `:`, `\32 ` to `2`: a CSS identifier as written in markup. */
function unescapeCss(ident) {
    return ident.replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?|\\([\s\S])/g, (_, hex, ch) => hex ? String.fromCodePoint(parseInt(hex, 16)) : (ch ?? ""));
}
/** A single class, then any pseudo-classes and a pseudo-element: `.md\:p-4`, `.hover\:x:hover`, `.a::before`. */
const SINGLE_CLASS = /^\.((?:\\[0-9a-fA-F]{1,6}[ \t\n\r\f]?|\\[^\n\r\f0-9a-fA-F]|[\w-]|[^\x00-\x7f])+)(?:::?[\w-]+(?:\([^()]*\))?)*$/;
/** The class name a single-class selector targets, unescaped; null for any other selector. */
export function utilityClass(selector) {
    const m = SINGLE_CLASS.exec(selector.trim());
    return m ? unescapeCss(m[1]) : null;
}
/** The words worth searching changed lines for: the distinctive ones, or all of them if none are. */
function searchTerms(ws) {
    const distinctive = ws.filter((w) => w.length >= 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
    return distinctive.length ? distinctive : ws;
}
/** Whether `text` holds the file name `name` as a whole, not inside a longer name (`a.png` in `data.png`). */
function holdsName(text, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^\\w.-])${escaped}(?:$|[^\\w.-])`).test(text);
}
/** The words two lines share, as a share of the first's: how much `b` reads like a rewrite of `a`. */
function likeness(a, b) {
    return a.size ? [...a].filter((w) => b.has(w)).length / a.size : 0;
}
/** Own images that animate or play, whose pixels can differ between loads with nothing changed. */
function animates(image) {
    return image.tag === "video" || /\.gif$/i.test(imageName(image.src) ?? "");
}
/** `text` in quotes, shortened for a note. */
function quote(text) {
    return JSON.stringify(text.length > 40 ? `${text.slice(0, 39)}…` : text);
}
/** The winning rule's selector, to say which rule took over. */
function winnerSelector(styles, el, prop) {
    const ref = el?.winners[prop]?.decl;
    return (ref && styles?.rules[ref[0]]?.selector) || "default";
}
/** A property's winning declaration and the `var()` declarations it goes through, as text. */
function winnerText(styles, el, prop) {
    const w = el?.winners[prop];
    if (!styles || !w?.decl)
        return "";
    const text = (ref) => {
        const rule = styles.rules[ref[0]];
        return rule?.decls[ref[1]] ? declText(rule, ref) : "?";
    };
    return [w.decl, ...(w.via ?? [])].map(text).join(" <- ");
}
export function correlate(input) {
    const layout = input.layoutProperties ?? LAYOUT_PROPERTIES;
    const repoPath = (p) => {
        const abs = path.isAbsolute(p) ? realpath(p) : path.join(input.root, p);
        const rel = path.relative(input.top, abs);
        return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : null;
    };
    // Changed lines per side: RIGHT by target path, LEFT by baseline path (mapped back to the target's).
    const added = new Map();
    const deleted = new Map();
    for (const [p, c] of input.changes) {
        added.set(p, c.added);
        deleted.set(c.oldPath, { lines: c.deleted, path: p });
    }
    /** A changed line, or with no line, a changed binary file. */
    const isChanged = (side, p, line) => line === undefined
        ? Boolean(side === "RIGHT" ? input.changes.get(p)?.binary : input.changes.get(deleted.get(p)?.path ?? p)?.binary)
        : side === "RIGHT"
            ? Boolean(added.get(p)?.has(line))
            : Boolean(deleted.get(p)?.lines.has(line));
    const targetPath = (side, p) => (side === "RIGHT" ? p : (deleted.get(p)?.path ?? p));
    const sourceLines = { LEFT: [], RIGHT: [] };
    const tokenCounts = (lines) => {
        const out = new Map();
        for (const text of lines.values())
            for (const t of tokens(text))
                out.set(t, (out.get(t) ?? 0) + 1);
        return out;
    };
    for (const [p, c] of input.changes) {
        const counts = { RIGHT: tokenCounts(c.added), LEFT: tokenCounts(c.deleted) };
        for (const [side, other, lines, sidePath] of [["RIGHT", "LEFT", c.added, p], ["LEFT", "RIGHT", c.deleted, c.oldPath]]) {
            if (STYLESHEET.test(sidePath))
                continue;
            const net = (t) => (counts[side].get(t) ?? 0) > (counts[other].get(t) ?? 0);
            for (const [line, text] of lines)
                sourceLines[side].push({ path: sidePath, line, text, words: new Set(words(text)), swapped: new Set(tokens(text).filter(net)) });
        }
    }
    const diffByTo = new Map();
    const diffByFrom = new Map();
    for (const d of input.diffs)
        (d.status === "removed" ? diffByFrom : diffByTo).set(d.filename, d);
    const file = (page, dir) => `${page}/${dir}/element.png`;
    const withoutStyles = [];
    const changed = [];
    const byNode = new Map();
    /** Per page: target node → parent and previous sibling, for knock-on effects. */
    const family = new Map();
    /** The same for baseline nodes, for removed elements. */
    const fromFamily = new Map();
    /** Target node → its baseline counterpart. */
    const toFrom = new Map();
    /** Old-side lines whose new-side counterpart was taken as the cause, as `path:line`. */
    const absorbed = new Set();
    /** Lines that sit inside a rule some element matched, per side, for invisible changes. */
    const ruleLines = { LEFT: new Map(), RIGHT: new Map() };
    const jsx = (side, node, via) => {
        const src = node?.component?.source;
        if (!src || src.generated)
            return null;
        const p = repoPath(src.fileName);
        return p ? { side, path: p, line: src.lineNumber, kind: "jsx", via } : null;
    };
    /**
     * Where the component that rendered `node` was called from. Only the
     * nearest: an edited `<Layout>` line further up didn't add everything in
     * it, and elements inside a new component are explained by its root.
     */
    const callSite = (side, node) => {
        const src = node.component?.components[0]?.source;
        const p = src && !src.generated ? repoPath(src.fileName) : null;
        return p && src ? { side, path: p, line: src.lineNumber, kind: "jsx", via: "jsx" } : null;
    };
    for (const page of input.pages) {
        const fromStyles = page.from.styles;
        const toStyles = page.to.styles;
        if (!fromStyles || !toStyles)
            withoutStyles.push(page.slug);
        for (const [side, styles] of [["LEFT", fromStyles], ["RIGHT", toStyles]]) {
            for (const rule of styles?.rules ?? []) {
                const p = rule.loc && repoPath(rule.loc.path);
                if (!p || !rule.loc)
                    continue;
                const spans = ruleLines[side].get(p) ?? [];
                spans.push([rule.loc.line, rule.loc.endLine ?? rule.loc.line]);
                ruleLines[side].set(p, spans);
            }
        }
        const bySelector = { LEFT: new Map(), RIGHT: new Map() };
        walk(page.from.manifest.elements, (n, parent, prev) => {
            bySelector.LEFT.set(n.selector, n);
            fromFamily.set(n, { parent, prev });
        });
        walk(page.to.manifest.elements, (n, parent, prev) => {
            bySelector.RIGHT.set(n.selector, n);
            family.set(n, { parent, prev });
        });
        for (const [b, a] of page.match.toFrom)
            toFrom.set(b, a);
        /** Where a declaration was written. Inline styles point at their element's JSX line. */
        const declLoc = (side, styles, ref, kind, via) => {
            const rule = styles.rules[ref[0]];
            if (!rule)
                return null;
            if (rule.inline) {
                const c = jsx(side, bySelector[side].get(rule.inline), via);
                return c && { ...c, text: declText(rule, ref) };
            }
            const loc = rule.decls[ref[1]]?.loc;
            const p = loc && repoPath(loc.path);
            return p && loc ? { side, path: p, line: loc.line, kind, via, text: declText(rule, ref) } : null;
        };
        const styleCandidates = (side, styles, el, prop) => {
            const w = styles && el?.winners[prop];
            if (!styles || !w?.decl)
                return [];
            const out = [];
            const direct = declLoc(side, styles, w.decl, "declaration", w.inherited ? "inherited" : "direct");
            if (direct)
                out.push(direct);
            for (const ref of w.via ?? []) {
                const v = declLoc(side, styles, ref, "variable", "var");
                if (v)
                    out.push(v);
            }
            return out;
        };
        /** The lines in `found` from the files that rendered `node` (its component and their callers), or all of them if none are. */
        const nearest = (node, found) => {
            const near = new Set([node.component?.source, ...(node.component?.components ?? []).map((c) => c.source)]
                .map((src) => (src && !src.generated ? repoPath(src.fileName) : null))
                .filter(Boolean));
            const own = found.filter((l) => near.has(l.path));
            return own.length ? own : found;
        };
        /**
         * Changed lines on `side` holding `terms`: those with the most of them,
         * narrowed to the files that rendered `node` if any of those qualify,
         * then to those most made of `text`'s words (copy, rather than code
         * that happens to share a word with it).
         */
        const copyLoc = (side, node, terms, text) => {
            let best = 0;
            let found = [];
            for (const l of sourceLines[side]) {
                const score = terms.filter((t) => l.words.has(t)).length;
                if (score > best)
                    [best, found] = [score, [l]];
                else if (score > 0 && score === best)
                    found.push(l);
            }
            found = nearest(node, found);
            const inText = new Set(text);
            const share = (l) => [...l.words].filter((w) => inText.has(w)).length / l.words.size;
            const top = Math.max(0, ...found.map(share));
            found = found.filter((l) => share(l) === top);
            if (found.length > MAX_MATCHING_LINES)
                return [];
            return found.map((l) => ({ side, path: l.path, line: l.line, kind: "content", content: "copy", via: "content", text: l.text.trim() }));
        };
        const imageCandidate = (side, path, line, text) => ({
            side,
            path,
            ...(line !== undefined ? { line } : {}),
            kind: "content",
            content: "image",
            via: "content",
            ...(text !== undefined ? { text } : {}),
        });
        /**
         * Changed lines that swapped an image source: for each deleted line
         * holding the name of an image `a` lost, the added line of its hunk
         * that reads most like it (what replaced it), or the deleted line
         * itself when the hunk added nothing; then the added lines holding the
         * name of an image `b` gained. Each narrowed to the files that rendered
         * the element, if any of those qualify. Replacements come first: that
         * line changed the value, while a gained name is often only an import.
         */
        const imageLoc = (a, b, lost, got) => {
            const left = [];
            const right = [];
            const replaced = nearest(a, sourceLines.LEFT.filter((l) => lost.some((n) => holdsName(l.text, n))));
            const gainedLines = nearest(b, sourceLines.RIGHT.filter((l) => got.some((n) => holdsName(l.text, n))));
            if (replaced.length <= MAX_MATCHING_LINES) {
                for (const l of replaced) {
                    const p = targetPath("LEFT", l.path);
                    const c = input.changes.get(p);
                    const hunk = c?.hunks.find((h) => h.oldCount > 0 && l.line >= h.oldStart && l.line < h.oldStart + h.oldCount);
                    let best = null;
                    for (let n = hunk?.newStart ?? 0; c && hunk && n < hunk.newStart + hunk.newCount; n++) {
                        const text = c.added.get(n);
                        if (text === undefined)
                            continue;
                        const score = likeness(l.words, new Set(words(text)));
                        if (!best || score > best.score)
                            best = { line: n, text, score };
                    }
                    if (best)
                        right.push(imageCandidate("RIGHT", p, best.line, best.text.trim()));
                    else
                        left.push(imageCandidate("LEFT", l.path, l.line, l.text.trim()));
                }
            }
            if (gainedLines.length <= MAX_MATCHING_LINES)
                for (const l of gainedLines)
                    right.push(imageCandidate("RIGHT", l.path, l.line, l.text.trim()));
            return { left, right };
        };
        /**
         * The image file `image` was served from, when it changed: a changed
         * binary file, or a changed SVG's first changed line (its first deleted
         * one when it only lost lines).
         */
        const imageFileLoc = (image) => {
            for (const abs of imageFiles(image.src, page.to.manifest.url, input.root, input.publicDir)) {
                const p = repoPath(abs);
                const c = p ? input.changes.get(p) : undefined;
                if (!p || !c)
                    continue;
                if (c.binary)
                    return { left: [], right: [imageCandidate("RIGHT", p, undefined, imageName(image.src) ?? undefined)] };
                const first = (lines) => Math.min(...lines.keys());
                if (c.added.size)
                    return { left: [], right: [imageCandidate("RIGHT", p, first(c.added), c.added.get(first(c.added))?.trim())] };
                if (c.deleted.size)
                    return { left: [imageCandidate("LEFT", c.oldPath, first(c.deleted), c.deleted.get(first(c.deleted))?.trim())], right: [] };
                break;
            }
            return { left: [], right: [] };
        };
        /** Whether the changed pixels `d` recorded for `node` all lie inside `image`'s box. */
        const changedInside = (d, node, image) => {
            const box = d.changedBox;
            if (!box)
                return false;
            const scale = page.to.manifest.scale || 1;
            const [x, y] = [node.box.x + box.x / scale, node.box.y + box.y / scale];
            const [right, bottom] = [x + box.width / scale, y + box.height / scale];
            const t = IMAGE_TOLERANCE;
            const r = image.box;
            return x >= r.x - t && y >= r.y - t && right <= r.x + r.width + t && bottom <= r.y + r.height + t;
        };
        /**
         * Look for what changed an element's own images, and return a note for
         * when nothing explains it. Images that hadn't loaded on either side are
         * unknown, not changed. Captures made before own images were recorded
         * have nothing to compare.
         */
        const traceImages = (entry, d, a, b) => {
            if ((page.from.manifest.version ?? 0) < IMAGES_VERSION || (page.to.manifest.version ?? 0) < IMAGES_VERSION)
                return null;
            const before = a.images ?? [];
            const after = b.images ?? [];
            if (!before.length && !after.length)
                return null;
            for (const [images, side] of [[before, "baseline"], [after, "target"]]) {
                const unloaded = images.find((i) => !i.loaded);
                if (unloaded)
                    return `its image (${imageName(unloaded.src) ?? unloaded.src}) hadn't loaded in the ${side}`;
            }
            const named = (images) => images.map((i) => imageName(i.src)).filter((n) => Boolean(n));
            const lost = gained(named(after), named(before));
            const got = gained(named(before), named(after));
            const hits = entry.hits.length;
            if (lost.length || got.length) {
                const { left, right } = imageLoc(a, b, lost, got);
                consider(entry, left, right);
                if (entry.hits.length > hits) {
                    entry.own = true;
                    return null;
                }
                const list = (names) => (names.length ? names.join(", ") : "none");
                return `its image source changed (${list(lost)} → ${list(got)}) but no changed line holds either name`;
            }
            for (const image of after) {
                const { left, right } = imageFileLoc(image);
                consider(entry, left, right);
            }
            if (entry.hits.length > hits) {
                entry.own = true;
                return null;
            }
            const shown = after.find((i) => !animates(i) && changedInside(d, b, i));
            if (!shown)
                return null;
            return (`pixels changed inside its image (${imageName(shown.src) ?? shown.src}), but neither its source nor its file changed: ` +
                "the file may have changed outside the repo, its pipeline (image service, sharp) may have changed, or something drew over it");
        };
        /**
         * Changed lines on `side` that added (RIGHT) or removed (LEFT) the class
         * `cls`, narrowed to the files that rendered `node` if any of those qualify.
         */
        const classLoc = (side, node, cls) => {
            if (!cls)
                return [];
            const found = nearest(node, sourceLines[side].filter((l) => l.swapped.has(cls)));
            if (found.length > MAX_MATCHING_LINES)
                return [];
            return found.map((l) => ({ side, path: l.path, line: l.line, kind: "jsx", via: "jsx", text: l.text.trim() }));
        };
        const selectorLoc = (side, styles, el, prop) => {
            const ref = styles && el?.winners[prop]?.decl;
            const rule = ref && styles?.rules[ref[0]];
            const p = rule?.loc && repoPath(rule.loc.path);
            return p && rule?.loc ? { side, path: p, line: rule.loc.line, kind: "selector", via: "direct", text: rule.selector } : null;
        };
        /**
         * Keep the candidates that sit on changed lines. A replaced line is both
         * deleted and added, so old-side hits only count when the new side has
         * none (a deleted rule, say).
         */
        const consider = (entry, left, right) => {
            const hit = (list) => list.filter((c) => Boolean(c && isChanged(c.side, c.path, c.line)));
            const onRight = hit(right);
            const onLeft = hit(left);
            if (onRight.length)
                for (const c of onLeft)
                    absorbed.add(causeLocation(c));
            // A line already found (copy on the element's JSX line, say) keeps what it was found as first.
            const seen = new Set(entry.hits.map((c) => `${c.side}:${causeLocation(c)}`));
            entry.hits.push(...(onRight.length ? onRight : onLeft).filter((c) => !seen.has(`${c.side}:${causeLocation(c)}`)));
        };
        const area = (n, scale) => (n ? Math.round(n.box.width * scale) * Math.round(n.box.height * scale) : 0);
        const sizeOf = (d, a, b) => d.mismatchedPixels ?? Math.max(area(a, page.from.manifest.scale), area(b, page.to.manifest.scale));
        walk(page.to.manifest.elements, (b) => {
            const a = page.match.toFrom.get(b);
            const d = diffByTo.get(file(page.slug, b.dir));
            if (!d || !(VISUAL.has(d.status) || d.status === "added"))
                return;
            const entry = { page: page.slug, node: b, fromNode: a, status: d.status, props: [], own: false, size: sizeOf(d, a, b), hits: [] };
            changed.push(entry);
            byNode.set(b, entry);
            if (!a) {
                consider(entry, [], [jsx("RIGHT", b, "jsx"), callSite("RIGHT", b)]);
                return;
            }
            const sa = fromStyles?.elements[a.dir];
            const sb = toStyles?.elements[b.dir];
            const switched = [];
            if (sa && sb) {
                for (const prop of Object.keys(sb.computed)) {
                    const before = sa.computed[prop] ?? null;
                    const after = sb.computed[prop] ?? null;
                    if (before === after)
                        continue;
                    if (layout.has(prop) && !sa.winners[prop]?.decl && !sb.winners[prop]?.decl)
                        continue;
                    const change = { name: prop, from: before, to: after };
                    entry.props.push(change);
                    // Same declaration, different value: a result of layout or an ancestor, not a cause.
                    if (winnerText(fromStyles, sa, prop) === winnerText(toStyles, sb, prop))
                        continue;
                    change.own = true;
                    entry.own = true;
                    consider(entry, styleCandidates("LEFT", fromStyles, sa, prop), styleCandidates("RIGHT", toStyles, sb, prop));
                    const selA = winnerSelector(fromStyles, sa, prop);
                    const selB = winnerSelector(toStyles, sb, prop);
                    if (selA !== selB) {
                        // A different rule won: its selector (or the markup that made it match) may be what changed.
                        consider(entry, [selectorLoc("LEFT", fromStyles, sa, prop)], [selectorLoc("RIGHT", toStyles, sb, prop)]);
                        // A utility class swapped in markup: the lost class on a deleted line, the gained one on an added line.
                        consider(entry, classLoc("LEFT", a, utilityClass(selA)), classLoc("RIGHT", b, utilityClass(selB)));
                        switched.push(`${prop}: ${selA} → ${selB}`);
                    }
                }
            }
            const notes = [];
            if (a.text !== undefined && b.text !== undefined && a.text !== b.text) {
                const before = words(a.text);
                const after = words(b.text);
                const hits = entry.hits.length;
                consider(entry, copyLoc("LEFT", a, searchTerms(gained(after, before)), before), copyLoc("RIGHT", b, searchTerms(gained(before, after)), after));
                if (entry.hits.length > hits)
                    entry.own = true;
                else
                    notes.push(`copy changed (${quote(a.text)} → ${quote(b.text)}) but no changed line has it`);
            }
            const imageNote = traceImages(entry, d, a, b);
            if (imageNote)
                notes.push(imageNote);
            consider(entry, [jsx("LEFT", a, "jsx")], [jsx("RIGHT", b, "jsx")]);
            if (switched.length)
                notes.push(`winner changed (${switched.slice(0, 3).join("; ")}${switched.length > 3 ? "; …" : ""})`);
            if (notes.length)
                entry.note = notes.join("; ");
        });
        walk(page.from.manifest.elements, (a) => {
            if (page.match.fromTo.has(a))
                return;
            const d = diffByFrom.get(file(page.slug, a.dir));
            if (!d)
                return;
            const entry = { page: page.slug, node: a, status: d.status, props: [], own: false, size: sizeOf(d, a, undefined), hits: [] };
            changed.push(entry);
            byNode.set(a, entry);
            consider(entry, [jsx("LEFT", a, "jsx"), callSite("LEFT", a)], []);
        });
    }
    const reasonKey = (r) => "element" in r ? `element:${r.element.page}:${r.element.status}:${r.element.node.dir}` : `${r.side}:${causeLocation(r)}`;
    /** The reasons each change resolves to: its own hits, its new or removed element, or those of its knock-on source. */
    const resolved = new Map();
    for (const entry of changed)
        if (entry.hits.length)
            resolved.set(entry, entry.hits);
    const entryOf = (n) => (n ? byNode.get(n) : undefined);
    const fresh = (e) => e.status === "added" || e.status === "removed";
    const parentOf = (e) => (e.status === "removed" ? fromFamily : family).get(e.node)?.parent ?? null;
    /** New or removed elements inside another one that explains them. */
    const inside = new Set();
    // Parents come before their children in `changed`, so an outer element is resolved first.
    for (const entry of changed) {
        if (!fresh(entry) || resolved.has(entry))
            continue;
        const up = entryOf(parentOf(entry));
        if (up && up.status === entry.status && resolved.has(up)) {
            resolved.set(entry, resolved.get(up));
            inside.add(entry);
        }
        else {
            resolved.set(entry, [{ element: entry }]);
        }
    }
    // Knock-on effects: changes with no cause and no change of their own come
    // from nearby changes that have one, going by geometry:
    //   - an element that moved or resized was pushed: by the nearest earlier
    //     sibling (of it or an ancestor) that resized or is new or removed,
    //     else by the nearest ancestor that moved, resized or changed itself;
    //     failing both, one that resized in a parent that didn't was squeezed
    //     by siblings on either side that resized or are new or removed;
    //   - an element whose box stayed put changed because of its content:
    //     its descendants' reasons, removed children included.
    // Either falls back to the other. Knock-on effects can explain each other,
    // so this repeats until nothing new is resolved.
    const children = new Map();
    for (const [n, f] of family)
        if (f.parent)
            children.set(f.parent, [...(children.get(f.parent) ?? []), n]);
    const fromChildren = new Map();
    for (const [n, f] of fromFamily)
        if (f.parent)
            fromChildren.set(f.parent, [...(fromChildren.get(f.parent) ?? []), n]);
    const resized = (e) => Boolean(e.fromNode && (e.fromNode.rect.width !== e.node.rect.width || e.fromNode.rect.height !== e.node.rect.height));
    const moved = (e) => Boolean(e.fromNode && (e.fromNode.rect.x !== e.node.rect.x || e.fromNode.rect.y !== e.node.rect.y));
    const removed = (n) => {
        const e = entryOf(n);
        return e?.status === "removed" ? e : undefined;
    };
    const pushedBy = (node) => {
        for (let n = node; n; n = family.get(n)?.parent ?? null) {
            for (let s = family.get(n)?.prev ?? null; s; s = family.get(s)?.prev ?? null) {
                const e = entryOf(s);
                if (e && (resized(e) || e.status === "added") && resolved.has(e))
                    return resolved.get(e);
            }
            // Earlier siblings that were removed, which only the baseline has.
            const a = toFrom.get(n);
            for (let s = (a && fromFamily.get(a)?.prev) ?? null; s; s = fromFamily.get(s)?.prev ?? null) {
                const e = removed(s);
                if (e && resolved.has(e))
                    return resolved.get(e);
            }
            const up = entryOf(family.get(n)?.parent);
            if (up && resolved.has(up) && (moved(up) || resized(up) || up.own))
                return resolved.get(up);
        }
        return undefined;
    };
    const sameSize = (a, b) => a.rect.width === b.rect.width && a.rect.height === b.rect.height;
    /** A parent that kept its size shared space out among its children, so a sibling that grew (or came or went) took it. */
    const squeezedBy = (entry) => {
        const parent = family.get(entry.node)?.parent;
        const before = parent && toFrom.get(parent);
        if (!parent || !before || !sameSize(before, parent) || !resized(entry))
            return undefined;
        const out = [];
        for (const s of children.get(parent) ?? []) {
            const e = entryOf(s);
            if (e && e !== entry && (resized(e) || e.status === "added"))
                out.push(...(resolved.get(e) ?? []));
        }
        for (const s of fromChildren.get(before) ?? []) {
            const e = removed(s);
            if (e)
                out.push(...(resolved.get(e) ?? []));
        }
        return out.length ? out : undefined;
    };
    const fromContent = (n) => {
        const out = [];
        for (const child of children.get(n) ?? []) {
            const e = entryOf(child);
            out.push(...((e && resolved.get(e)) ?? fromContent(child)));
        }
        const a = toFrom.get(n);
        for (const child of (a && fromChildren.get(a)) ?? []) {
            const e = removed(child);
            if (e)
                out.push(...(resolved.get(e) ?? []));
        }
        return out;
    };
    const knockOn = new Set();
    for (let progress = true; progress;) {
        progress = false;
        for (const entry of changed) {
            if (resolved.has(entry) || entry.own || !family.has(entry.node))
                continue;
            const geometry = moved(entry) || resized(entry);
            const content = () => {
                const below = fromContent(entry.node);
                return below.length ? below : undefined;
            };
            const found = geometry ? (pushedBy(entry.node) ?? squeezedBy(entry) ?? content()) : (content() ?? pushedBy(entry.node));
            if (found) {
                resolved.set(entry, [...new Map(found.map((r) => [reasonKey(r), r])).values()]);
                knockOn.add(entry);
                progress = true;
            }
        }
    }
    const effectOf = (entry, via) => ({
        page: entry.page,
        dir: entry.node.dir,
        ...(entry.fromNode && entry.fromNode.dir !== entry.node.dir ? { fromDir: entry.fromNode.dir } : {}),
        status: entry.status,
        props: entry.props,
        via,
        size: entry.size,
    });
    const has = (effects, entry) => effects.some((e) => e.page === entry.page && e.dir === entry.node.dir && e.status === entry.status);
    const causes = new Map();
    const keyOf = (c) => `${c.side}:${causeLocation({ path: targetPath(c.side, c.path), line: c.line })}`;
    const addEffect = (c, entry, via) => {
        const key = keyOf(c);
        let cause = causes.get(key);
        if (!cause) {
            cause = {
                path: targetPath(c.side, c.path),
                ...(c.line !== undefined ? { line: c.line } : {}),
                side: c.side,
                kind: c.kind,
                ...(c.content ? { content: c.content } : {}),
                text: c.text,
                effects: [],
            };
            causes.set(key, cause);
        }
        if (!has(cause.effects, entry))
            cause.effects.push(effectOf(entry, via));
    };
    // A new or removed element's render site is its parent's JSX line. Those
    // without one are grouped by their own JSX line, else listed by themselves.
    const sites = new Map();
    const addSiteEffect = (element, entry, via) => {
        const side = element.status === "removed" ? "LEFT" : "RIGHT";
        const at = jsx(side, parentOf(element), "jsx");
        const own = at ? null : jsx(side, element.node, "jsx");
        const key = at ? keyOf(at) : own ? `own:${keyOf(own)}` : `element:${element.page}:${element.status}:${element.node.dir}`;
        let site = sites.get(key);
        if (!site) {
            site = { ...(at ? { path: targetPath(side, at.path), line: at.line } : {}), side, effects: [] };
            sites.set(key, site);
        }
        if (!has(site.effects, entry))
            site.effects.push(effectOf(entry, via));
    };
    const unexplained = [];
    for (const entry of changed) {
        const found = resolved.get(entry);
        if (found) {
            for (const r of found) {
                if ("element" in r) {
                    const via = r.element === entry ? (entry.status === "removed" ? "removed" : "new") : inside.has(entry) ? "inside" : "knock-on";
                    addSiteEffect(r.element, entry, via);
                }
                else {
                    addEffect(r, entry, knockOn.has(entry) ? "knock-on" : inside.has(entry) ? "inside" : r.via);
                }
            }
        }
        else {
            unexplained.push({
                page: entry.page,
                dir: entry.node.dir,
                ...(entry.fromNode && entry.fromNode.dir !== entry.node.dir ? { fromDir: entry.fromNode.dir } : {}),
                status: entry.status,
                props: entry.props,
                ...(entry.note ? { note: entry.note } : {}),
            });
        }
    }
    for (const site of sites.values()) {
        const elements = site.effects.filter((e) => e.via === "new" || e.via === "removed");
        site.representative = pickRepresentative(elements.length ? elements : site.effects, (e) => e.size);
    }
    // Cross-reference effects that share an element, and pick each cause's screenshot.
    const causesOf = new Map();
    for (const cause of causes.values()) {
        for (const e of cause.effects) {
            const k = `${e.page}/${e.dir}`;
            causesOf.set(k, [...(causesOf.get(k) ?? []), causeLocation(cause)]);
        }
    }
    for (const cause of causes.values()) {
        const own = causeLocation(cause);
        for (const e of cause.effects) {
            const others = [...new Set(causesOf.get(`${e.page}/${e.dir}`) ?? [])].filter((c) => c !== own);
            if (others.length)
                e.alsoCausedBy = others;
        }
        // Knock-on effects include containers up to the whole page, so they're
        // only shown when the line changed nothing directly.
        const direct = cause.effects.filter((e) => e.via !== "knock-on");
        cause.representative = pickRepresentative(direct.length ? direct : cause.effects, (e) => e.size);
    }
    // Changed stylesheet lines that didn't cause anything.
    const used = new Set([...causes.values()].map((c) => `${c.side}:${c.path}:${c.line}`));
    const invisible = [];
    const inRule = (side, p, line) => (ruleLines[side].get(p) ?? []).some(([start, end]) => line >= start && line <= end);
    const stylesheet = (p) => STYLESHEET.test(p) || ruleLines.LEFT.has(p) || ruleLines.RIGHT.has(p);
    for (const [p, c] of input.changes) {
        for (const [side, lines, sidePath] of [["RIGHT", c.added, p], ["LEFT", c.deleted, c.oldPath]]) {
            if (!stylesheet(sidePath))
                continue;
            for (const line of lines.keys()) {
                if (used.has(`${side}:${p}:${line}`) || (side === "LEFT" && absorbed.has(`${sidePath}:${line}`)))
                    continue;
                invisible.push({ path: p, line, side, reason: inRule(side, sidePath, line) ? "no-effect" : "not-exercised" });
            }
        }
    }
    const sorted = [...causes.values()].sort((x, y) => x.path.localeCompare(y.path) || (x.line ?? 0) - (y.line ?? 0) || x.side.localeCompare(y.side));
    invisible.sort((x, y) => x.path.localeCompare(y.path) || x.line - y.line);
    const renderSites = [...sites.values()].sort((x, y) => (x.path ?? "\uffff").localeCompare(y.path ?? "\uffff") || (x.line ?? 0) - (y.line ?? 0) || x.side.localeCompare(y.side));
    return { causes: sorted, renderSites, unexplained, invisible, withoutStyles };
}
/** Correlation input for the per-element pages of a `diffVersions` report, with each side's style data. */
export function correlationPages(report, fromDir, toDir) {
    return [...(report.pairs ?? new Map())].map(([slug, pair]) => ({
        slug,
        from: { manifest: pair.from, styles: readStyleManifest(path.join(fromDir, slug, STYLE_MANIFEST)) },
        to: { manifest: pair.to, styles: readStyleManifest(path.join(toDir, slug, STYLE_MANIFEST)) },
        match: pair.match,
    }));
}
/**
 * Correlate a `diffVersions` report between versions `from` and `to` with the
 * lines changed between the files they were captured from. Returns a reason
 * instead when that isn't possible.
 */
export function correlateVersions(paths, report) {
    if (!report.pairs?.size)
        return { skipped: "no per-element captures on both sides" };
    const changes = versionChanges(paths, report.from, report.to);
    if ("skipped" in changes)
        return changes;
    return correlate({
        pages: correlationPages(report, versionDir(paths, report.from), versionDir(paths, report.to)),
        diffs: report.pages,
        changes,
        root: realpath(paths.root),
        top: realpath(topLevel(paths.root) ?? paths.root),
        publicDir: publicDir(paths.root),
    });
}
/** Lines changed between the files versions `from` and `to` were captured from, or why they can't be known. */
export function versionChanges(paths, from, to) {
    if (!isGitRepo(paths.root))
        return { skipped: "not a git repository" };
    const [fromRev, toRev] = [from, to].map((key) => {
        const meta = readMeta(paths, key);
        return meta ? versionRev(meta) : null;
    });
    if (!fromRev || !toRev) {
        return { skipped: "a version was captured from uncommitted changes before snapshots existed; re-capture it" };
    }
    return changedLines(paths.root, fromRev, toRev) ?? { skipped: `couldn't diff ${fromRev.slice(0, 7)}..${toRev.slice(0, 7)}` };
}
/** Carries source lines of version `from` over to version `to`, for matching their elements; null when that isn't possible. */
export function versionMapper(paths, from, to) {
    const changes = versionChanges(paths, from, to);
    return "skipped" in changes ? null : new LineMapper(changes, repoPrefix(paths.root));
}
/** Add `correlation` (or why it was skipped) to a report. */
export function addCorrelation(paths, report) {
    const result = correlateVersions(paths, report);
    if ("skipped" in result)
        report.correlationSkipped = result.skipped;
    else
        report.correlation = result;
    return report;
}
