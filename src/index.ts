import { RunService } from "@rbxts/services";

export enum ProviderServiceType {
	Client,
	Server,
	Module,
}

export interface ServiceMetadata {
	ProviderServiceType: ProviderServiceType;
	name: string;
	dependencies?: { [index: number]: string };
	[key: string]: unknown;
}

export interface ProviderConstructor {
	new (name: string, metadata: ServiceMetadata, metatable?: Record<string, unknown>): Provider;
}

export class ProviderServiceError {
	name: string;
	message: string;

	constructor(message: string) {
		this.name = "ProviderServiceError";
		this.message = message;
	}
}

export class CircularDependencyError extends ProviderServiceError {
	constructor(chain: string[]) {
		super(`Circular dependency detected: ${chain.join(" -> ")}`);
		this.name = "CircularDependencyError";
	}
}

export class ServiceNotFoundError extends ProviderServiceError {
	constructor(serviceName: string) {
		super(`Service '${serviceName}' not found`);
		this.name = "ServiceNotFoundError";
	}
}

export class ServiceTypeMismatchError extends ProviderServiceError {
	constructor(serviceName: string, expectedType: ProviderServiceType, actualType: ProviderServiceType) {
		super(
			`Service '${serviceName}' type mismatch. Expected ${ProviderServiceType[expectedType]}, got ${ProviderServiceType[actualType]}`,
		);
		this.name = "ServiceTypeMismatchError";
	}
}

export class Provider {
	private readonly metadata: ServiceMetadata;
	private metatable: Record<string, unknown>;
	private initialized = false;
	private started = false;
	private dependencies: Record<string, Provider> = {};

	constructor(name: string, metadata: ServiceMetadata, metatable: Record<string, unknown> = {}) {
		this.metadata = {
			...metadata,
			name,
			ProviderServiceType: metadata.ProviderServiceType,
			dependencies: metadata.dependencies || [],
		};
		this.metatable = metatable;
	}

	getMetadata(): ServiceMetadata {
		return this.metadata;
	}

	getMetatable(): Record<string, unknown> {
		return this.metatable;
	}

	setMetatable(metatable: Record<string, unknown>): void {
		this.metatable = metatable;
		setmetatable(this, this.metatable);
	}

	async init(): Promise<void> {
		if (this.initialized) return;
		this.initialized = true;
	}

	async start(): Promise<void> {
		if (!this.initialized) await this.init();
		if (this.started) return;
		this.started = true;
	}

	async stop(): Promise<void> {
		if (!this.started) return;
		this.started = false;
	}

	async destroy(): Promise<void> {
		await this.stop();
		this.initialized = false;
	}

	getDependency<T extends Provider>(name: string): T {
		const dependency = this.dependencies[name];
		if (!dependency) {
			throw new ServiceNotFoundError(`Dependency '${name}' not found for service '${this.metadata.name}'`);
		}
		return dependency as T;
	}

	setDependency(name: string, provider: Provider): void {
		this.dependencies[name] = provider;
	}

	hasDependency(name: string): boolean {
		return this.dependencies[name] !== undefined;
	}
}

export class ProviderService {
	private readonly providers: Map<string, Provider> = new Map();
	private readonly dependencyGraph: Map<string, Set<string>> = new Map();
	private initialized = false;

	private getDependenciesArray(dependencies: { [index: number]: string }): string[] {
		const result: string[] = [];
		for (let i = 1; i <= 100; i++) {
			// Limit to prevent infinite loops
			const dep = dependencies[i as unknown as number];
			if (dep) {
				result.push(dep);
			} else {
				break;
			}
		}
		return result;
	}

	private findCycleDependency(tempVisited: Set<string>, current: string): string {
		for (const dep of tempVisited) {
			if (this.dependencyGraph.get(current)?.has(dep)) {
				return dep;
			}
		}
		return current;
	}

	init(): void {
		if (this.initialized) return;
		this.initialized = true;
	}

	getProviders(): Map<string, Provider> {
		const result = new Map<string, Provider>();
		for (const [key, value] of this.providers) {
			result.set(key, value);
		}
		return result;
	}

	getClientProviders(): Map<string, Provider> {
		const result = new Map<string, Provider>();
		for (const [name, provider] of this.providers) {
			if (provider.getMetadata().ProviderServiceType === ProviderServiceType.Client) {
				result.set(name, provider);
			}
		}
		return result;
	}

	getServerProviders(): Map<string, Provider> {
		const result = new Map<string, Provider>();
		for (const [name, provider] of this.providers) {
			if (provider.getMetadata().ProviderServiceType === ProviderServiceType.Server) {
				result.set(name, provider);
			}
		}
		return result;
	}

	getModuleProviders(): Map<string, Provider> {
		const result = new Map<string, Provider>();
		for (const [name, provider] of this.providers) {
			if (provider.getMetadata().ProviderServiceType === ProviderServiceType.Module) {
				result.set(name, provider);
			}
		}
		return result;
	}

	exists(name: string): boolean {
		return this.providers.has(name);
	}

	getProvider<T extends Provider>(name: string): T {
		const provider = this.providers.get(name);
		if (!provider) {
			throw new ServiceNotFoundError(name);
		}

		const metadata = provider.getMetadata();
		const expectedType = metadata.ProviderServiceType;

		// Check client-server compliance
		if (expectedType === ProviderServiceType.Module) {
			return provider as T;
		} else if (expectedType === ProviderServiceType.Client && RunService.IsServer()) {
			throw new ServiceTypeMismatchError(name, ProviderServiceType.Client, ProviderServiceType.Server);
		} else if (expectedType === ProviderServiceType.Server && RunService.IsClient()) {
			throw new ServiceTypeMismatchError(name, ProviderServiceType.Server, ProviderServiceType.Client);
		}

		return provider as T;
	}

	createProvider(
		name: string,
		serviceType: ProviderServiceType,
		metadata: Omit<ServiceMetadata, "ProviderServiceType" | "name"> = {},
		metatable: Record<string, unknown> = {},
	): Provider {
		if (this.providers.has(name)) {
			throw new ProviderServiceError(`Provider '${name}' already exists`);
		}

		const fullMetadata: ServiceMetadata = {
			name,
			ProviderServiceType: serviceType,
			...metadata,
		};

		const provider = new Provider(name, fullMetadata, metatable);
		this.providers.set(name, provider);

		// Build dependency graph
		if (metadata.dependencies) {
			const dependencies = new Set<string>();
			for (let i = 1; i <= 100; i++) {
				// Limit to prevent infinite loops
				const dep = (metadata.dependencies as unknown as { [index: number]: string })[i];
				if (dep) {
					dependencies.add(dep);
				} else {
					break;
				}
			}
			if (dependencies.size() > 0) {
				this.dependencyGraph.set(name, dependencies);
			}
		}

		return provider;
	}

	async startProvider(name: string): Promise<Provider> {
		const provider = this.getProvider(name);
		await provider.start();
		return provider;
	}

	async stopProvider(name: string): Promise<void> {
		const provider = this.getProvider(name);
		await provider.stop();
	}

	async destroyProvider(name: string): Promise<void> {
		const provider = this.getProvider(name);
		await provider.destroy();
		this.providers.delete(name);
		this.dependencyGraph.delete(name);
	}

	async startAllProviders(): Promise<void> {
		// Topological sort to resolve dependencies
		const sortedServices = this.topologicalSort();

		for (const serviceName of sortedServices) {
			try {
				await this.startProvider(serviceName);
			} catch (e) {
				// Continue with other services even if one fails
				continue;
			}
		}
	}

	async stopAllProviders(): Promise<void> {
		// Stop in reverse order of dependencies
		const sortedServices = this.topologicalSort();
		for (let i = sortedServices.size() - 1; i >= 0; i--) {
			try {
				await this.stopProvider(sortedServices[i]);
			} catch (e) {
				// Continue with other services even if one fails
				continue;
			}
		}
	}

	connect<T extends (...args: unknown[]) => unknown>(providerName: string, methodName: string, method: T): void {
		const provider = this.getProvider(providerName);
		(provider as unknown as Record<string, unknown>)[methodName] = method;
	}

	async injectDependencies(providerName: string): Promise<void> {
		const provider = this.getProvider(providerName);
		const metadata = provider.getMetadata();

		if (metadata.dependencies) {
			for (let i = 1; i <= 100; i++) {
				// Limit to prevent infinite loops
				const dependencyName = (metadata.dependencies as unknown as { [index: number]: string })[i];
				if (dependencyName) {
					if (!this.providers.has(dependencyName)) {
						throw new ServiceNotFoundError(
							`Dependency '${dependencyName}' required by '${providerName}' not found`,
						);
					}

					const dependency = this.getProvider(dependencyName);
					provider.setDependency(dependencyName, dependency);
				} else {
					break;
				}
			}
		}
	}

	private topologicalSort(): string[] {
		const visited: Set<string> = new Set();
		const result: string[] = [];
		const tempVisited: Set<string> = new Set();

		const visit = (node: string) => {
			if (tempVisited.has(node)) {
				// Find the cycle path
				const cycle = [node];
				let current = node;
				while (current !== node || cycle.size() === 1) {
					current = this.findCycleDependency(tempVisited, current);
					if (current === node && cycle.size() > 1) break;
					cycle.push(current);
				}
				throw new CircularDependencyError(cycle);
			}

			if (visited.has(node)) return;

			tempVisited.add(node);
			const dependencies = this.dependencyGraph.get(node) || new Set();
			for (const dep of dependencies) {
				visit(dep);
			}
			tempVisited.delete(node);

			visited.add(node);
			result.push(node);
		};

		for (const [serviceName] of this.providers) {
			if (!visited.has(serviceName)) {
				visit(serviceName);
			}
		}

		return result;
	}
}

// Export for roblox-ts
export default {
	Provider,
	ProviderService,
	ProviderServiceType,
	ProviderServiceError,
	CircularDependencyError,
	ServiceNotFoundError,
	ServiceTypeMismatchError,
};
