import * as winston from 'winston';
import * as path from 'path';
import * as fs from 'fs';

const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const { combine, timestamp, printf, colorize, errors } = winston.format;

const logFormat = printf(({ level, message, timestamp: ts, agent, ...meta }) => {
  const agentTag = agent ? ` [${agent}]` : '';
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${ts} ${String(level).toUpperCase()}${agentTag} ${message}${metaStr}`;
});

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  format: combine(errors({ stack: true }), timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), logFormat),
  transports: [
    new winston.transports.Console({
      format: combine(colorize(), timestamp({ format: 'HH:mm:ss' }), logFormat),
    }),
    new winston.transports.File({ filename: path.join(logsDir, 'error.log'), level: 'error' }),
    new winston.transports.File({ filename: path.join(logsDir, 'orchestrator.log') }),
  ],
});

export function agentLogger(agentName: string) {
  return {
    info:  (msg: string, meta?: object) => logger.info(msg,  { agent: agentName, ...meta }),
    warn:  (msg: string, meta?: object) => logger.warn(msg,  { agent: agentName, ...meta }),
    error: (msg: string, meta?: object) => logger.error(msg, { agent: agentName, ...meta }),
    debug: (msg: string, meta?: object) => logger.debug(msg, { agent: agentName, ...meta }),
  };
}
