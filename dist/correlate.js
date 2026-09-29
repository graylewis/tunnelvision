import path from "node:path";
import { STYLE_MANIFEST } from "./elements.js";
import { changedLines, isGitRepo, topLevel } from "./git.js";
import { realpath } from "./reactsource.js";
import { readMeta, versionRev } from "./versions.js";
import { versionDir } from "./paths.js";
import { pickRepresentative } from "./representative.js";
import { readStyleManifest } from "./styles.js";
const VISUAL = new Set(["changed", "size-mismatch"]);
const STYLESHEET = /\.(css|scss|sass|less|styl|pcss|postcss)$/i;
export const LAYOUT_PROPERTIES = new Set(["width", "height", "min-width", "min-height", "max-width", "max-height"]);
/** Words too common to say which line some copy came from, unless nothing else changed. */
const STOP_WORDS = new Set(["the", "and", "for", "you", "your", "are", "with", "this", "that", "from", "our", "was", "has", "have", "its"]);
/** More changed lines than this containing an element's new copy is a coincidence, not a cause. */
const MAX_COPY_LINES = 5;
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
/** The words worth searching changed lines for: the distinctive ones, or all of them if none are. */
function searchTerms(ws) {
    const distinctive = ws.filter((w) => w.length >= 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
    return distinctive.length ? distinctive : ws;
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
    const isChanged = (side, p, line) => side === "RIGHT" ? Boolean(added.get(p)?.has(line)) : Boolean(deleted.get(p)?.lines.has(line));
    const targetPath = (side, p) => (side === "RIGHT" ? p : (deleted.get(p)?.path ?? p));
    // Changed lines copy could be on, with their words: anything but stylesheets.
    const copyLines = { LEFT: [], RIGHT: [] };
    for (const [p, c] of input.changes) {
        for (const [side, lines, sidePath] of [["RIGHT", c.added, p], ["LEFT", c.deleted, c.oldPath]]) {
            if (STYLESHEET.test(sidePath))
                continue;
            for (const [line, text] of lines)
                copyLines[side].push({ path: sidePath, line, text, words: new Set(words(text)) });
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
    /** Old-side lines whose new-side counterpart was taken as the cause, as `path:line`. */
    const absorbed = new Set();
    /** Lines that sit inside a rule some element matched, per side, for invisible changes. */
    const ruleLines = { LEFT: new Map(), RIGHT: new Map() };
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
        walk(page.from.manifest.elements, (n) => bySelector.LEFT.set(n.selector, n));
        walk(page.to.manifest.elements, (n, parent, prev) => {
            bySelector.RIGHT.set(n.selector, n);
            family.set(n, { parent, prev });
        });
        const jsx = (side, node, via) => {
            const src = node?.component?.source;
            if (!src || src.generated)
                return null;
            const p = repoPath(src.fileName);
            return p ? { side, path: p, line: src.lineNumber, kind: "jsx", via } : null;
        };
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
        /**
         * Changed lines on `side` holding `terms`: those with the most of them,
         * narrowed to the files that rendered `node` if any of those qualify,
         * then to those most made of `text`'s words (copy, rather than code
         * that happens to share a word with it).
         */
        const copyLoc = (side, node, terms, text) => {
            let best = 0;
            let found = [];
            for (const l of copyLines[side]) {
                const score = terms.filter((t) => l.words.has(t)).length;
                if (score > best)
                    [best, found] = [score, [l]];
                else if (score > 0 && score === best)
                    found.push(l);
            }
            const near = new Set([node.component?.source, ...(node.component?.components ?? []).map((c) => c.source)]
                .map((src) => (src && !src.generated ? repoPath(src.fileName) : null))
                .filter(Boolean));
            const own = found.filter((l) => near.has(l.path));
            if (own.length)
                found = own;
            const inText = new Set(text);
            const share = (l) => [...l.words].filter((w) => inText.has(w)).length / l.words.size;
            const top = Math.max(0, ...found.map(share));
            found = found.filter((l) => share(l) === top);
            if (found.length > MAX_COPY_LINES)
                return [];
            return found.map((l) => ({ side, path: l.path, line: l.line, kind: "copy", via: "copy", text: l.text.trim() }));
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
                    absorbed.add(`${c.path}:${c.line}`);
            // A line already found (copy on the element's JSX line, say) keeps what it was found as first.
            const seen = new Set(entry.hits.map((c) => `${c.side}:${c.path}:${c.line}`));
            entry.hits.push(...(onRight.length ? onRight : onLeft).filter((c) => !seen.has(`${c.side}:${c.path}:${c.line}`)));
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
                consider(entry, [], [jsx("RIGHT", b, "jsx")]);
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
            consider(entry, [jsx("LEFT", a, "jsx")], []);
        });
    }
    // Knock-on effects: changes with no cause and no change of their own come
    // from nearby changes that have one, going by geometry:
    //   - an element that moved or resized was pushed: by the nearest earlier
    //     sibling (of it or an ancestor) that resized, else by the nearest
    //     ancestor that moved, resized or changed itself;
    //   - an element whose box stayed put changed because of its content:
    //     its descendants' causes.
    // Either falls back to the other. Knock-on effects can explain each other,
    // so this repeats until nothing new is resolved.
    const children = new Map();
    for (const [n, f] of family)
        if (f.parent)
            children.set(f.parent, [...(children.get(f.parent) ?? []), n]);
    /** The causes each change resolves to: its own hits, or those of its knock-on source. */
    const resolved = new Map();
    for (const entry of changed)
        if (entry.hits.length)
            resolved.set(entry, entry.hits);
    const entryOf = (n) => (n ? byNode.get(n) : undefined);
    const resized = (e) => Boolean(e.fromNode && (e.fromNode.rect.width !== e.node.rect.width || e.fromNode.rect.height !== e.node.rect.height));
    const moved = (e) => Boolean(e.fromNode && (e.fromNode.rect.x !== e.node.rect.x || e.fromNode.rect.y !== e.node.rect.y));
    const pushedBy = (node) => {
        for (let n = node; n; n = family.get(n)?.parent ?? null) {
            for (let s = family.get(n)?.prev ?? null; s; s = family.get(s)?.prev ?? null) {
                const e = entryOf(s);
                if (e && resized(e) && resolved.has(e))
                    return resolved.get(e);
            }
            const up = entryOf(family.get(n)?.parent);
            if (up && resolved.has(up) && (moved(up) || resized(up) || up.own))
                return resolved.get(up);
        }
        return undefined;
    };
    const fromContent = (n) => {
        const out = [];
        for (const child of children.get(n) ?? []) {
            const e = entryOf(child);
            out.push(...((e && resolved.get(e)) ?? fromContent(child)));
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
            const found = geometry ? (pushedBy(entry.node) ?? content()) : (content() ?? pushedBy(entry.node));
            if (found) {
                resolved.set(entry, [...new Map(found.map((c) => [`${c.side}:${c.path}:${c.line}`, c])).values()]);
                knockOn.add(entry);
                progress = true;
            }
        }
    }
    const causes = new Map();
    const keyOf = (c) => `${c.side}:${targetPath(c.side, c.path)}:${c.line}`;
    const addEffect = (c, entry, via) => {
        const key = keyOf(c);
        let cause = causes.get(key);
        if (!cause) {
            cause = { path: targetPath(c.side, c.path), line: c.line, side: c.side, kind: c.kind, text: c.text, effects: [] };
            causes.set(key, cause);
        }
        if (cause.effects.some((e) => e.page === entry.page && e.dir === entry.node.dir))
            return;
        cause.effects.push({
            page: entry.page,
            dir: entry.node.dir,
            ...(entry.fromNode && entry.fromNode.dir !== entry.node.dir ? { fromDir: entry.fromNode.dir } : {}),
            status: entry.status,
            props: entry.props,
            via,
            size: entry.size,
        });
    };
    const unexplained = [];
    for (const entry of changed) {
        const found = resolved.get(entry);
        if (found) {
            for (const c of found)
                addEffect(c, entry, knockOn.has(entry) ? "knock-on" : c.via);
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
    // Cross-reference effects that share an element, and pick each cause's screenshot.
    const causesOf = new Map();
    for (const cause of causes.values()) {
        for (const e of cause.effects) {
            const k = `${e.page}/${e.dir}`;
            causesOf.set(k, [...(causesOf.get(k) ?? []), `${cause.path}:${cause.line}`]);
        }
    }
    for (const cause of causes.values()) {
        const own = `${cause.path}:${cause.line}`;
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
    const sorted = [...causes.values()].sort((x, y) => x.path.localeCompare(y.path) || x.line - y.line || x.side.localeCompare(y.side));
    invisible.sort((x, y) => x.path.localeCompare(y.path) || x.line - y.line);
    return { causes: sorted, unexplained, invisible, withoutStyles };
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
    if (!isGitRepo(paths.root))
        return { skipped: "not a git repository" };
    const revs = [report.from, report.to].map((key) => {
        const meta = readMeta(paths, key);
        return meta ? versionRev(meta) : null;
    });
    const [fromRev, toRev] = revs;
    if (!fromRev || !toRev) {
        return { skipped: "a version was captured from uncommitted changes before snapshots existed; re-capture it" };
    }
    const changes = changedLines(paths.root, fromRev, toRev);
    if (!changes)
        return { skipped: `couldn't diff ${fromRev.slice(0, 7)}..${toRev.slice(0, 7)}` };
    return correlate({
        pages: correlationPages(report, versionDir(paths, report.from), versionDir(paths, report.to)),
        diffs: report.pages,
        changes,
        root: realpath(paths.root),
        top: realpath(topLevel(paths.root) ?? paths.root),
    });
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
