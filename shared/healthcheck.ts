import { Router } from 'express';

export function healthRoute(serviceName: string): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: serviceName,
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}
