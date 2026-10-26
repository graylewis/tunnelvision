/**
 * TanStack Query (v4, v5): one unit per successful query, identified by its
 * query hash. Replay seeds the QueryClient at React's first commit, before
 * the effects in which queries subscribe and fetch, and pins each replayed
 * query's `fetch` to its seeded data (see docs/adr/0011 and FINDINGS.md).
 */
/** Bumped whenever what's recorded or how it's replayed changes. */
const VERSION = "1";
/**
 * Query data and keys are JSON plus whatever the app's queryFns return:
 * Dates, Maps, Sets, BigInts, undefined. `window.__tvCodec` round-trips those;
 * other class instances come back as plain objects.
 */
export const CODEC_JS = `(() => {
	const TAG = "$tv";
	const encode = (v) => {
		if (v === undefined) return { [TAG]: "undefined" };
		if (typeof v === "bigint") return { [TAG]: "BigInt", v: String(v) };
		if (typeof v === "number" && !Number.isFinite(v)) return { [TAG]: "Number", v: String(v) };
		if (typeof v === "function" || typeof v === "symbol") return { [TAG]: "undefined" };
		if (v === null || typeof v !== "object") return v;
		if (v instanceof Date) return { [TAG]: "Date", v: v.toISOString() };
		if (v instanceof Map) return { [TAG]: "Map", v: [...v].map(([k, x]) => [encode(k), encode(x)]) };
		if (v instanceof Set) return { [TAG]: "Set", v: [...v].map(encode) };
		if (Array.isArray(v)) return v.map(encode);
		const out = {};
		for (const k of Object.keys(v)) out[k] = encode(v[k]);
		return TAG in v ? { [TAG]: "Object", v: out } : out;
	};
	const decode = (v) => {
		if (v === null || typeof v !== "object") return v;
		if (Array.isArray(v)) return v.map(decode);
		switch (v[TAG]) {
			case "undefined": return undefined;
			case "BigInt": return BigInt(v.v);
			case "Number": return Number(v.v);
			case "Date": return new Date(v.v);
			case "Map": return new Map(v.v.map(([k, x]) => [decode(k), decode(x)]));
			case "Set": return new Set(v.v.map(decode));
			case "Object": v = v.v;
		}
		const out = {};
		for (const k of Object.keys(v)) out[k] = decode(v[k]);
		return out;
	};
	window.__tvCodec = { encode, decode };
})();`;
/**
 * Installed before the app's scripts. Takes the DevTools hook's place (React
 * Refresh wraps it rather than replacing it), keeping the `renderers` map
 * other tools read. At the first commit that holds a QueryClientProvider it
 * remembers the client and seeds the replayed queries.
 */
function hook(units) {
    const w = globalThis; // eslint-disable-line @typescript-eslint/no-explicit-any
    const state = (w.__tvQuery = {
        client: null, // eslint-disable-line @typescript-eslint/no-explicit-any
        /** Replayed query hashes → the dataUpdatedAt they were seeded with. */
        seeded: {},
        cancelled: [],
        blocked: {},
    });
    const isClient = (c) => c && typeof c.getQueryCache === "function" && typeof c.setQueryData === "function"; // eslint-disable-line @typescript-eslint/no-explicit-any
    const findClient = (fiber) => {
        const stack = [fiber];
        while (stack.length) {
            const f = stack.pop();
            if (!f)
                continue;
            if (isClient(f.memoizedProps?.client))
                return f.memoizedProps.client;
            stack.push(f.sibling, f.child);
        }
        return null;
    };
    const seed = (client) => {
        const cache = client.getQueryCache();
        for (const u of units) {
            const { key, data, dataUpdatedAt } = w.__tvCodec.decode(u.data);
            const before = cache.get(u.id);
            if (before && before.state.fetchStatus === "fetching") {
                // Reverts synchronously, and the cancelled fetch then resolves
                // with whatever the query holds: the seeded data.
                before.cancel({ revert: true });
                state.cancelled.push(u.id);
            }
            client.setQueryData(key, data, { updatedAt: dataUpdatedAt });
            const q = cache.get(u.id);
            if (!q)
                continue;
            // Recorded data is stale by any staleTime under a frozen clock, so
            // mounts, intervals and invalidations would still fetch.
            q.fetch = function () {
                state.blocked[u.id] = (state.blocked[u.id] ?? 0) + 1;
                return Promise.resolve(this.state.data);
            };
            state.seeded[u.id] = q.state.dataUpdatedAt;
        }
    };
    const renderers = new Map();
    let id = 0;
    const previous = w.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        renderers,
        supportsFiber: true,
        checkDCE() { },
        inject(renderer) {
            renderers.set(++id, renderer);
            previous?.inject?.(renderer);
            return id;
        },
        onScheduleFiberRoot(...args) {
            previous?.onScheduleFiberRoot?.(...args);
        },
        onCommitFiberRoot(rendererId, root, ...rest) {
            if (!state.client) {
                const client = isClient(w.__TANSTACK_QUERY_CLIENT__) ? w.__TANSTACK_QUERY_CLIENT__ : findClient(root.current);
                if (client) {
                    state.client = client;
                    seed(client);
                }
            }
            previous?.onCommitFiberRoot?.(rendererId, root, ...rest);
        },
        onCommitFiberUnmount(...args) {
            previous?.onCommitFiberUnmount?.(...args);
        },
        onPostCommitFiberRoot(...args) {
            previous?.onPostCommitFiberRoot?.(...args);
        },
    };
}
/** Find the client after the fact, for a page whose first commit the hook missed. */
const FIND_CLIENT_JS = `() => {
	const s = window.__tvQuery;
	if (s && s.client) return true;
	const isClient = (c) => c && typeof c.getQueryCache === "function" && typeof c.setQueryData === "function";
	let client = isClient(window.__TANSTACK_QUERY_CLIENT__) ? window.__TANSTACK_QUERY_CLIENT__ : null;
	for (const el of client ? [] : document.querySelectorAll("*")) {
		const key = Object.keys(el).find((k) => k.startsWith("__reactContainer$"));
		if (!key) continue;
		const stack = [el[key]];
		while (stack.length && !client) {
			const f = stack.pop();
			if (!f) continue;
			if (isClient(f.memoizedProps && f.memoizedProps.client)) client = f.memoizedProps.client;
			stack.push(f.sibling, f.child);
		}
		if (client) break;
	}
	if (!client) return false;
	window.__tvQuery = { ...(s || { seeded: {}, cancelled: [], blocked: {} }), client };
	return true;
}`;
export default function tanstackQuery() {
    return {
        name: "tanstack-query",
        version: VERSION,
        async replay(page, units) {
            await page.addInitScript({ content: CODEC_JS });
            await page.addInitScript(hook, units);
        },
        async record(page) {
            const found = await page.evaluate(`(${FIND_CLIENT_JS})()`);
            if (!found)
                return { units: [], skipped: [] };
            const seen = (await page.evaluate(() => {
                const w = globalThis; // eslint-disable-line @typescript-eslint/no-explicit-any
                const units = [];
                const skipped = [];
                const warnings = [];
                for (const [id, at] of Object.entries(w.__tvQuery.seeded)) {
                    const q = w.__tvQuery.client.getQueryCache().get(id);
                    if (q && q.state.dataUpdatedAt !== at)
                        warnings.push(`${id}: replayed data was replaced after replay (a live fetch, or the app setting it)`);
                }
                for (const q of w.__tvQuery.client.getQueryCache().getAll()) {
                    const { status, fetchStatus, error } = q.state;
                    if (status === "success") {
                        // Hold what's shown until the screenshot: a background refetch is
                        // dropped, and polling, refocus and invalidation get the same data.
                        if (fetchStatus === "fetching")
                            q.cancel({ revert: true });
                        q.fetch = function () {
                            return Promise.resolve(this.state.data);
                        };
                        const { data, dataUpdatedAt } = q.state;
                        units.push({ id: q.queryHash, data: w.__tvCodec.encode({ key: q.queryKey, data, dataUpdatedAt }) });
                    }
                    else if (status === "error") {
                        skipped.push({ id: q.queryHash, reason: `error: ${String(error?.message ?? error).split("\n")[0]}` });
                    }
                    else if (fetchStatus === "fetching") {
                        skipped.push({ id: q.queryHash, reason: "still loading when recorded" });
                    }
                    // pending and idle: a disabled query that never ran, nothing on the page
                }
                return { units, skipped, warnings };
            }));
            const units = await Promise.all(seen.units.map(async (u) => ({
                ...u,
                rerun: await page.evaluateHandle((hash) => {
                    const w = globalThis; // eslint-disable-line @typescript-eslint/no-explicit-any
                    return () => {
                        const client = w.__tvQuery.client;
                        const q = client.getQueryCache().get(hash);
                        return q.options.queryFn({
                            queryKey: q.queryKey,
                            signal: new AbortController().signal,
                            meta: q.meta,
                            client,
                            pageParam: q.options.initialPageParam,
                            direction: "forward",
                        });
                    };
                }, u.id),
            })));
            return { units, skipped: seen.skipped, warnings: seen.warnings };
        },
    };
}
