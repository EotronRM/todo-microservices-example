const CONSUL_HOST = process.env.CONSUL_HOST || 'localhost';
const CONSUL_PORT = process.env.CONSUL_PORT || '8500';
const CONSUL_BASE = `http://${CONSUL_HOST}:${CONSUL_PORT}/v1`;

export interface ServiceInstance {
  address: string;
  port: number;
}

export async function registerService(
  name: string,
  address: string,
  port: number
): Promise<void> {
  const body = {
    Name: name,
    ID: `${name}-${port}`,
    Address: address,
    Port: port,
    Check: {
      HTTP: `http://${address}:${port}/health`,
      Interval: '10s',
      Timeout: '2s',
    },
  };

  const res = await fetch(`${CONSUL_BASE}/agent/service/register`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Failed to register ${name}: ${res.statusText}`);
  }

  console.log(`[Consul] Registered ${name} at ${address}:${port}`);
}

export async function deregisterService(
  name: string,
  port: number
): Promise<void> {
  const id = `${name}-${port}`;
  const res = await fetch(`${CONSUL_BASE}/agent/service/deregister/${id}`, {
    method: 'PUT',
  });

  if (!res.ok) {
    console.error(`[Consul] Failed to deregister ${id}: ${res.statusText}`);
  } else {
    console.log(`[Consul] Deregistered ${id}`);
  }
}

export async function discoverService(
  name: string
): Promise<ServiceInstance> {
  const res = await fetch(
    `${CONSUL_BASE}/health/service/${name}?passing=true`
  );

  if (!res.ok) {
    throw new Error(`[Consul] Failed to discover ${name}: ${res.statusText}`);
  }

  const entries = (await res.json()) as any[];

  if (entries.length === 0) {
    throw new Error(`[Consul] No healthy instances of ${name}`);
  }

  const entry = entries[0];
  return {
    address: entry.Service.Address,
    port: entry.Service.Port,
  };
}

export function setupGracefulShutdown(
  name: string,
  port: number
): void {
  const shutdown = async () => {
    console.log(`\n[${name}] Shutting down...`);
    await deregisterService(name, port);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
