/**
 * AEGIS-T2A API Server
 *
 * Express server setup with middleware and error handling.
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createRouter } from './routes.js';
import { getConfig } from '../core/config.js';
import { componentLogger, requestLogger } from '../core/logger.js';
import { generateId } from '../core/ids.js';

const logger = componentLogger('server');

// =============================================================================
// Error Types
// =============================================================================

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// =============================================================================
// Middleware
// =============================================================================

function requestIdMiddleware(req: Request, _res: Response, next: NextFunction): void {
  req.headers['x-request-id'] = req.headers['x-request-id'] ?? generateId();
  next();
}

function loggingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.headers['x-request-id'] as string;
  const log = requestLogger(requestId, req.method, req.path);

  const startTime = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    log.info(
      { statusCode: res.statusCode, durationMs: duration },
      `${req.method} ${req.path} ${res.statusCode}`
    );
  });

  next();
}

function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const requestId = req.headers['x-request-id'] as string;

  if (err instanceof ApiError) {
    logger.warn({ requestId, error: err.message, code: err.code }, 'API error');
    res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
      requestId,
    });
    return;
  }

  if (err.name === 'ZodError') {
    logger.warn({ requestId, error: err.message }, 'Validation error');
    res.status(400).json({
      error: 'Validation error',
      details: err.message,
      requestId,
    });
    return;
  }

  logger.error({ requestId, err }, 'Unhandled error');
  res.status(500).json({
    error: 'Internal server error',
    requestId,
  });
}

// =============================================================================
// Server Factory
// =============================================================================

export function createServer(): Express {
  const app = express();
  const config = getConfig();

  // Security middleware
  app.use(helmet());
  app.use(cors());

  // Rate limiting
  const limiter = rateLimit({
    windowMs: config.rateLimitWindowMs,
    max: config.rateLimitMaxRequests,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
  });
  app.use(limiter);

  // Body parsing
  app.use(express.json({ limit: '10mb' }));

  // Request tracking
  app.use(requestIdMiddleware);
  app.use(loggingMiddleware);

  // API routes
  app.use('/api/v1', createRouter());

  // Root endpoint
  app.get('/', (_req, res) => {
    res.json({
      name: 'AEGIS-T2A',
      description: 'Text-to-Action Anywhere Platform',
      version: process.env['npm_package_version'] ?? '0.1.0',
      docs: '/api/v1/health',
    });
  });

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Error handler
  app.use(errorHandler);

  return app;
}

export default createServer;
