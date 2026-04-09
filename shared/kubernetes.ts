// Kubernetes discovery backend
// In K8s, services are reachable via DNS: http://<service-name>
// K8s Services map port 80 → container port, so no port needed.
// No registration or deregistration needed — K8s handles it via Endpoints.

export interface ServiceInstance {
  address: string;
  port: number;
}

export async function registerService(
  name: string,
  _address: string,
  _port: number
): Promise<void> {
  // No-op: Kubernetes discovers services automatically via Endpoints
  console.log(`[K8s] Service ${name} — registration not needed (handled by Kubernetes)`);
}

export async function deregisterService(
  _name: string,
  _port: number
): Promise<void> {
  // No-op: Kubernetes removes pods from Endpoints automatically
}

export async function discoverService(
  name: string
): Promise<ServiceInstance> {
  // K8s Services expose port 80 and map to the container's actual port.
  // kube-proxy handles load balancing across healthy pods.
  console.log(`[K8s] Discovered ${name} → ${name}:80`);
  return { address: name, port: 80 };
}

export function setupGracefulShutdown(
  name: string,
  _port: number
): void {
  // Kubernetes sends SIGTERM and waits for terminationGracePeriodSeconds
  const shutdown = () => {
    console.log(`\n[${name}] Shutting down...`);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
