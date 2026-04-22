export const HUMAN_ROLE_VALUES = [
  'customer',
  'user',
  'staff',
  'agent',
  'cashier',
  'operator',
  'manager',
  'supervisor',
  'owner',
] as const

export type StoreHumanRole = (typeof HUMAN_ROLE_VALUES)[number]
