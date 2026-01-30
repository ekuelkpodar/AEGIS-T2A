/**
 * AEGIS-T2A API Server
 *
 * Express server setup with middleware and error handling.
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
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

  // Security middleware - configured for frontend assets
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "http://localhost:*", "ws://localhost:*"],
      },
    },
  }));
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

  // Serve static frontend files
  const frontendPath = path.join(process.cwd(), 'frontend');
  app.use(express.static(frontendPath));

  // Serve index.html for all non-API routes (SPA support)
  app.get('*', (req, res, next) => {
    // Skip API routes
    if (req.path.startsWith('/api/')) {
      return next();
    }
    res.sendFile(path.join(frontendPath, 'index.html'));
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
