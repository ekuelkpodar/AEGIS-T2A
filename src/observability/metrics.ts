/**
 * Lightweight metrics registry (Prometheus text format).
 */

import { componentLogger } from '../core/logger.js';

const logger = componentLogger('metrics');

type MetricType = 'counter' | 'gauge';

interface Metric {
  name: string;
  help?: string;
  type: MetricType;
  value: number;
}

class MetricsRegistry {
  private metrics = new Map<string, Metric>();

  define(name: string, type: MetricType, help?: string): void {
    if (this.metrics.has(name)) return;
    this.metrics.set(name, { name, type, help, value: 0 });
  }

  inc(name: string, value: number = 1): void {
    const metric = this.metrics.get(name);
    if (!metric) {
      this.metrics.set(name, { name, type: 'counter', value });
      return;
    }
    metric.value += value;
  }

  set(name: string, value: number): void {
    const metric = this.metrics.get(name);
    if (!metric) {
      this.metrics.set(name, { name, type: 'gauge', value });
      return;
    }
    metric.value = value;
  }

  snapshot(): Metric[] {
    return Array.from(this.metrics.values());
  }

  renderPrometheus(): string {
    const lines: string[] = [];
    for (const metric of this.metrics.values()) {
      if (metric.help) {
        lines.push(`# HELP ${metric.name} ${metric.help}`);
      }
      lines.push(`# TYPE ${metric.name} ${metric.type}`);
      lines.push(`${metric.name} ${metric.value}`);
    }
    return lines.join('\n') + '\n';
  }
}

let registry: MetricsRegistry | null = null;

export function getMetricsRegistry(): MetricsRegistry {
  if (!registry) {
    registry = new MetricsRegistry();
    logger.info('Metrics registry initialized');
  }
  return registry;
}
