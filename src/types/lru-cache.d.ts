declare module "lru-cache" {
	export default class LRU<K, V> {
		constructor(options?: {
			max?: number
			maxAge?: number
			length?: (value: V, key: K) => number
			dispose?: (key: K, value: V) => void
			stale?: boolean
			ttl?: number
		})

		set(key: K, value: V): void
		get(key: K): V | undefined
		peek(key: K): V | undefined
		del(key: K): void
		reset(): void
		has(key: K): boolean
		clear(): void
	}
}
