import { ExtensionContext } from "vscode"
import { ApiConfiguration } from "../../shared/api"
import { Mode } from "../../shared/modes"
import { ApiConfigMeta } from "../../shared/ExtensionMessage"

export interface ApiConfigData {
	currentApiConfigName: string
	apiConfigs: {
		[key: string]: ApiConfiguration
	}
	modeApiConfigs?: Partial<Record<Mode, string>>
}

export class ConfigManager {
	private readonly defaultConfig: ApiConfigData = {
		currentApiConfigName: "default",
		apiConfigs: {
			default: {
				id: this.generateId(),
			},
		},
	}

	private readonly SCOPE_PREFIX = "roo_cline_config_"
	private readonly context: ExtensionContext

	constructor(context: ExtensionContext) {
		this.context = context
		this.initConfig().catch(console.error)
	}

	private generateId(): string {
		return Math.random().toString(36).substring(2, 15)
	}

	// Synchronize readConfig/writeConfig operations to avoid data loss.
	private _lock = Promise.resolve()
	private lock<T>(cb: () => Promise<T>) {
		const next = this._lock.then(cb)
		this._lock = next.catch(() => {}) as Promise<void>
		return next
	}
	/**
	 * Initialize config if it doesn't exist
	 */
	async initConfig(): Promise<void> {
		try {
			return await this.lock(async () => {
				const config = await this.readConfig()
				if (!config) {
					await this.writeConfig(this.defaultConfig)
					return
				}

				// Migrate: ensure all configs have IDs
				let needsMigration = false
				for (const [name, apiConfig] of Object.entries(config.apiConfigs)) {
					if (!apiConfig.id) {
						apiConfig.id = this.generateId()
						needsMigration = true
					}
				}

				if (needsMigration) {
					await this.writeConfig(config)
				}
			})
		} catch (error) {
			throw new Error(`Failed to initialize config: ${error}`)
		}
	}

	/**
	 * List all available configs with metadata
	 */
	async listConfig(): Promise<ApiConfigMeta[]> {
		try {
			return await this.lock(async () => {
				const config = await this.readConfig()
				return Object.entries(config.apiConfigs).map(([name, apiConfig]) => ({
					name,
					id: apiConfig.id || "",
					apiProvider: apiConfig.apiProvider,
				}))
			})
		} catch (error) {
			throw new Error(`Failed to list configs: ${error}`)
		}
	}

	/**
	 * Save a config with the given name.
	 * Preserves the ID from the input 'config' object if it exists,
	 * otherwise generates a new one (for creation scenarios).
	 */
	async saveConfig(name: string, config: ApiConfiguration): Promise<void> {
		try {
			return await this.lock(async () => {
				const currentConfig = await this.readConfig()

				// Preserve the existing ID if this is an update to an existing config
				const existingId = currentConfig.apiConfigs[name]?.id

				currentConfig.apiConfigs[name] = {
					...config,
					id: config.id || existingId || this.generateId(),
				}

				await this.writeConfig(currentConfig)
			})
		} catch (error) {
			throw new Error(`Failed to save config: ${error}`)
		}
	}

	/**
	 * Load a config by name
	 */
	async loadConfig(name: string): Promise<ApiConfiguration> {
		try {
			return await this.lock(async () => {
				const config = await this.readConfig()
				const apiConfig = config.apiConfigs[name]

				if (!apiConfig) {
					throw new Error(`Config '${name}' not found`)
				}

				config.currentApiConfigName = name
				await this.writeConfig(config)

				return apiConfig
			})
		} catch (error) {
			throw new Error(`Failed to load config: ${error}`)
		}
	}

	/**
	 * Load a config by ID
	 */
	async loadConfigById(id: string): Promise<{ config: ApiConfiguration; name: string }> {
		try {
			return await this.lock(async () => {
				const config = await this.readConfig()

				// Find the config with the matching ID
				const entry = Object.entries(config.apiConfigs).find(([_, apiConfig]) => apiConfig.id === id)

				if (!entry) {
					throw new Error(`Config with ID '${id}' not found`)
				}

				const [name, apiConfig] = entry

				// Update current config name
				config.currentApiConfigName = name
				await this.writeConfig(config)

				return { config: apiConfig, name }
			})
		} catch (error) {
			throw new Error(`Failed to load config by ID: ${error}`)
		}
	}

	/**
	 * Delete a config by name
	 */
	async deleteConfig(name: string): Promise<void> {
		try {
			return await this.lock(async () => {
				const currentConfig = await this.readConfig()
				if (!currentConfig.apiConfigs[name]) {
					throw new Error(`Config '${name}' not found`)
				}

				// Don't allow deleting the default config
				if (Object.keys(currentConfig.apiConfigs).length === 1) {
					throw new Error(`Cannot delete the last remaining configuration.`)
				}

				delete currentConfig.apiConfigs[name]
				await this.writeConfig(currentConfig)
			})
		} catch (error) {
			throw new Error(`Failed to delete config: ${error}`)
		}
	}

	/**
	 * Set the current active API configuration
	 */
	async setCurrentConfig(name: string): Promise<void> {
		try {
			return await this.lock(async () => {
				const currentConfig = await this.readConfig()
				if (!currentConfig.apiConfigs[name]) {
					throw new Error(`Config '${name}' not found`)
				}

				currentConfig.currentApiConfigName = name
				await this.writeConfig(currentConfig)
			})
		} catch (error) {
			throw new Error(`Failed to set current config: ${error}`)
		}
	}

	/**
	 * Check if a config exists by name
	 */
	async hasConfig(name: string): Promise<boolean> {
		try {
			return await this.lock(async () => {
				const config = await this.readConfig()
				return name in config.apiConfigs
			})
		} catch (error) {
			throw new Error(`Failed to check config existence: ${error}`)
		}
	}

	/**
	 * Set the API config for a specific mode
	 */
	async setModeConfig(mode: Mode, configId: string): Promise<void> {
		try {
			return await this.lock(async () => {
				const currentConfig = await this.readConfig()
				if (!currentConfig.modeApiConfigs) {
					currentConfig.modeApiConfigs = {}
				}
				currentConfig.modeApiConfigs[mode] = configId
				await this.writeConfig(currentConfig)
			})
		} catch (error) {
			throw new Error(`Failed to set mode config: ${error}`)
		}
	}

	/**
	 * Get the API config ID for a specific mode
	 */
	async getModeConfigId(mode: Mode): Promise<string | undefined> {
		try {
			return await this.lock(async () => {
				const config = await this.readConfig()
				return config.modeApiConfigs?.[mode]
			})
		} catch (error) {
			throw new Error(`Failed to get mode config: ${error}`)
		}
	}

	/**
	 * Get the key used for storing config in secrets
	 */
	private getConfigKey(): string {
		return `${this.SCOPE_PREFIX}api_config`
	}

	/**
	 * Reset all configuration by deleting the stored config from secrets
	 */
	public async resetAllConfigs(): Promise<void> {
		return await this.lock(async () => {
			await this.context.secrets.delete(this.getConfigKey())
		})
	}

	private async readConfig(): Promise<ApiConfigData> {
		try {
			const content = await this.context.secrets.get(this.getConfigKey())

			if (!content) {
				return this.defaultConfig
			}

			return JSON.parse(content)
		} catch (error) {
			throw new Error(`Failed to read config from secrets: ${error}`)
		}
	}

	private async writeConfig(config: ApiConfigData): Promise<void> {
		try {
			const content = JSON.stringify(config, null, 2)
			await this.context.secrets.store(this.getConfigKey(), content)
		} catch (error) {
			throw new Error(`Failed to write config to secrets: ${error}`)
		}
	}
}
