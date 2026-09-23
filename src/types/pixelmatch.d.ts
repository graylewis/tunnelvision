declare module "pixelmatch" {
	interface PixelmatchOptions {
		threshold?: number;
		includeAA?: boolean;
		alpha?: number;
		aaColor?: [number, number, number];
		diffColor?: [number, number, number];
		diffColorAlt?: [number, number, number] | null;
		diffMask?: boolean;
	}
	export default function pixelmatch(
		img1: Uint8Array | Uint8ClampedArray | Buffer,
		img2: Uint8Array | Uint8ClampedArray | Buffer,
		output: Uint8Array | Uint8ClampedArray | Buffer | null,
		width: number,
		height: number,
		options?: PixelmatchOptions,
	): number;
}
