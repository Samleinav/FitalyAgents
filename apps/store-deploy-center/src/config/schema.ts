import { z } from 'zod'

const ServiceKindSchema = z.enum([
  'infra',
  'runtime',
  'ui',
  'customer-display',
  'avatar',
  'voice',
  'custom',
])

const ScreenKindSchema = z.enum(['staff-ui', 'customer-display', 'avatar', 'orders', 'custom'])

export const DeployServiceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  service_name: z.string().min(1),
  kind: ServiceKindSchema.default('custom'),
  health_url: z.string().url().optional(),
  enabled: z.boolean().default(true),
})

export const DeployScreenSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: ScreenKindSchema.default('custom'),
  url: z.string().url().optional(),
  health_url: z.string().url().optional(),
  enabled: z.boolean().default(true),
})

export const DeployCenterConfigSchema = z.object({
  project: z.object({
    name: z.string().min(1).default('Fitaly Store Deploy Center'),
    store_config_path: z.string().min(1).default('../store-runtime/store.config.redis.json'),
    compose_file_path: z.string().min(1).default('../store-runtime/docker-compose.yml'),
    working_directory: z.string().min(1).default('../store-runtime'),
    env_file_path: z.string().min(1).default('../store-runtime/.env'),
    env_example_path: z.string().min(1).default('../store-runtime/.env.example'),
    profiles: z.array(z.string().min(1)).default([]),
    logs_tail_lines: z.number().int().positive().default(120),
  }),
  http: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().positive().default(3030),
    })
    .default({}),
  services: z.array(DeployServiceSchema).default([]),
  screens: z.array(DeployScreenSchema).default([]),
})

export type DeployCenterConfig = z.infer<typeof DeployCenterConfigSchema>
export type DeployServiceConfig = DeployCenterConfig['services'][number]
export type DeployScreenConfig = DeployCenterConfig['screens'][number]
