const ETCD_HOST = process.env.ETCD_HOST || 'localhost';
const ETCD_PORT = process.env.ETCD_PORT || '2379';
const ETCD_BASE = `http://${ETCD_HOST}:${ETCD_PORT}`;

const LEASE_TTL = 15; // seconds
const KEEPALIVE_INTERVAL = 5000; // milliseconds

const toBase64 = (s: string) => Buffer.from(s).toString('base64');
const fromBase64 = (s: string) => Buffer.from(s, 'base64').toString('utf-8');

export interface ServiceInstance {
  address: string;
  port: number;
}

// Module-level state: etcd requires client-side lease management
// (unlike Consul, where the server tracks health independently)
let leaseId: string | null = null;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

export async function registerService(
  name: string,
  address: string,
  port: number
): Promise<void> {
  // Step 1: Grant a lease with TTL
  // If this service dies, the lease expires and the key is auto-deleted
  const leaseRes = await fetch(`${ETCD_BASE}/v3/lease/grant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ TTL: LEASE_TTL }),
  });

  if (!leaseRes.ok) {
    throw new Error(`[etcd] Failed to grant lease: ${leaseRes.statusText}`);
  }

  const leaseData = (await leaseRes.json()) as { ID: string; TTL: string };
  leaseId = leaseData.ID;

  // Step 2: Register the service by writing a key with the lease attached
  // Key format: /services/<name>/instances/<name>-<port>
  const key = `/services/${name}/instances/${name}-${port}`;
  const value = JSON.stringify({ address, port });

  const putRes = await fetch(`${ETCD_BASE}/v3/kv/put`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: toBase64(key),
      value: toBase64(value),
      lease: leaseId,
    }),
  });

  if (!putRes.ok) {
    throw new Error(`[etcd] Failed to register ${name}: ${putRes.statusText}`);
  }

  // Step 3: Start periodic keepalive to renew the lease
  // Without this, the lease expires after LEASE_TTL and the key is deleted
  keepAliveTimer = setInterval(async () => {
    try {
      const res = await fetch(`${ETCD_BASE}/v3/lease/keepalive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ID: leaseId }),
      });
      if (!res.ok) {
        console.error(`[etcd] Keepalive failed: ${res.statusText}`);
      }
    } catch (err) {
      console.error(`[etcd] Keepalive error:`, err);
    }
  }, KEEPALIVE_INTERVAL);

  console.log(
    `[etcd] Registered ${name} at ${address}:${port} (lease=${leaseId}, TTL=${LEASE_TTL}s)`
  );
}

export async function deregisterService(
  name: string,
  port: number
): Promise<void> {
  const id = `${name}-${port}`;
  const key = `/services/${name}/instances/${id}`;

  // Stop the keepalive loop
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }

  // Delete the key explicitly
  try {
    await fetch(`${ETCD_BASE}/v3/kv/deleterange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: toBase64(key) }),
    });
  } catch (err) {
    console.error(`[etcd] Failed to delete key for ${id}:`, err);
  }

  // Revoke the lease (also deletes any attached keys)
  if (leaseId) {
    try {
      await fetch(`${ETCD_BASE}/v3/lease/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ID: leaseId }),
      });
    } catch (err) {
      console.error(`[etcd] Failed to revoke lease for ${id}:`, err);
    }
    leaseId = null;
  }

  console.log(`[etcd] Deregistered ${id}`);
}

export async function discoverService(
  name: string
): Promise<ServiceInstance> {
  // Prefix range query: get all keys under /services/<name>/instances/
  // range_end uses the next ASCII character after '/' (which is '0')
  // to capture all keys with this prefix
  const prefix = `/services/${name}/instances/`;
  const rangeEnd = `/services/${name}/instances0`;

  const res = await fetch(`${ETCD_BASE}/v3/kv/range`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: toBase64(prefix),
      range_end: toBase64(rangeEnd),
    }),
  });

  if (!res.ok) {
    throw new Error(`[etcd] Failed to discover ${name}: ${res.statusText}`);
  }

  const data = (await res.json()) as { kvs?: { key: string; value: string }[] };
  const kvs = data.kvs || [];

  if (kvs.length === 0) {
    throw new Error(`[etcd] No healthy instances of ${name}`);
  }

  // CLIENT SERVICE DISCOVERY
  // Pick a random instance for basic load distribution
  const kv = kvs[Math.floor(Math.random() * kvs.length)];
  const instance = JSON.parse(fromBase64(kv.value)) as ServiceInstance;

  console.log(
    `[etcd] Discovered ${name}: ${instance.address}:${instance.port} (${kvs.length} instance(s))`
  );

  return instance;
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
