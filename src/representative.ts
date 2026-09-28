/**
 * Pick the one visual change shown for a cause: the largest that isn't an
 * outlier among everything the cause affected.
 *
 * Outliers are values above the upper Tukey fence (Q3 + 1.5·IQR). A single
 * page-sized container that repaints because of a colour token would
 * otherwise always win over the button the change was really about. With
 * fewer than four effects there's too little to call anything an outlier, so
 * the largest is picked.
 */
export function pickRepresentative<T>(effects: T[], size: (t: T) => number): T | undefined {
	if (effects.length === 0) return undefined;
	const sized = effects.map((effect) => ({ effect, size: size(effect) }));
	const largest = (xs: typeof sized) => xs.reduce((best, x) => (x.size > best.size ? x : best)).effect;
	if (sized.length < 4) return largest(sized);

	const sorted = sized.map((x) => x.size).sort((a, b) => a - b);
	const q1 = quantile(sorted, 0.25);
	const q3 = quantile(sorted, 0.75);
	const fence = q3 + 1.5 * (q3 - q1);
	// Q3 never exceeds the fence, so at least one effect is always inside it.
	return largest(sized.filter((x) => x.size <= fence));
}

/** The `q` quantile of ascending `sorted`, linearly interpolated between closest ranks. */
function quantile(sorted: number[], q: number): number {
	const pos = (sorted.length - 1) * q;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
