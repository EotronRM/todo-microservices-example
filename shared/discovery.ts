// Adapter: selects Consul, etcd, or Kubernetes based on DISCOVERY_BACKEND env var
// Default: consul (preserves existing behavior)

const backend = process.env.DISCOVERY_BACKEND || 'consul';

const mod =
  backend === 'kubernetes'
    ? await import('./kubernetes.js')
    : backend === 'etcd'
      ? await import('./etcd.js')
      : await import('./consul.js');

export type { ServiceInstance } from './consul.js';

export const registerService = mod.registerService;
export const discoverService = mod.discoverService;
export const deregisterService = mod.deregisterService;
export const setupGracefulShutdown = mod.setupGracefulShutdown;
