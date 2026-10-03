import { z } from 'zod';
import { DEFAULT_JOB_NAME } from '../services/jenkins-service';

const baseUrl = z
  .string()
  .trim()
  .max(300, 'The URL is too long (300 characters at most).')
  .regex(/^https?:\/\/[^\s]+$/i, 'Enter a URL that starts with http:// or https://')
  .transform((v) => v.replace(/\/+$/, ''));
const username = z.string().trim().min(1, 'Enter the Jenkins username.').max(100);
const token = z.string().min(1).max(200, 'The API token is too long (200 characters at most).');
const jobName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/, 'Use letters, digits, dot, dash, and underscore only.');

export const saveJenkinsBody = z.object({
  baseUrl,
  username,
  jobName: jobName.default(DEFAULT_JOB_NAME),
  token: token.optional(),
});

export const testJenkinsBody = z.object({
  baseUrl: baseUrl.optional(),
  username: username.optional(),
  token: token.optional(),
});

export const jenkinsSettingsResponse = z.object({
  settings: z.object({
    configured: z.boolean(),
    baseUrl: z.string(),
    username: z.string(),
    jobName: z.string(),
    hasToken: z.boolean(),
  }),
});

export const jenkinsTestResponse = z.object({
  ok: z.boolean(),
  version: z.string().nullable(),
  pipelinePlugin: z.boolean(),
  message: z.string(),
});

export const jenkinsJobResponse = z.object({ created: z.boolean(), jobUrl: z.string() });
