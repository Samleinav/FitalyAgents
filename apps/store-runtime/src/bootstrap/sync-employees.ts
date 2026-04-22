import type { HumanProfile, InMemoryPresenceManager } from 'fitalyagents'
import type { StoreConfig } from '../config/schema.js'
import type { EmployeeRepository } from '../storage/repositories/employees.js'

export function syncEmployees(
  repository: EmployeeRepository,
  presenceManager: InMemoryPresenceManager,
  employees: StoreConfig['employees'],
  storeId: string,
): void {
  const ids = employees.map((employee) => employee.id)
  repository.deleteMissingConfigEmployees(ids)

  for (const employee of employees) {
    repository.upsert(employee)

    const profile: HumanProfile = {
      id: employee.id,
      name: employee.name,
      role: employee.role,
      org_id: storeId,
      store_id: storeId,
      approval_limits: employee.approval_limits,
      is_present: false,
    }

    presenceManager.update(profile, 'offline', storeId)
  }
}
