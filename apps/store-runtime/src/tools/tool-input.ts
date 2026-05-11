export interface ToolOrderLine {
  product_id: string
  quantity: number
  price: number
}

export function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function readNumber(value: unknown): number | undefined {
  const numeric =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(numeric) ? numeric : undefined
}

export function readInteger(value: unknown): number | undefined {
  const numeric = readNumber(value)
  return numeric == null ? undefined : Math.trunc(numeric)
}

export function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value !== 'string') {
    return undefined
  }

  if (value.toLowerCase() === 'true') {
    return true
  }
  if (value.toLowerCase() === 'false') {
    return false
  }

  return undefined
}

export function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((entry) => {
    const text = readString(entry)
    return text ? [text] : []
  })
}

export function readOrderLines(value: unknown): ToolOrderLine[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((entry) => {
    const line = readRecord(entry)
    const productId = readString(line.product_id) ?? readString(line.id)
    const quantity = readNumber(line.quantity)
    const price = readNumber(line.price)

    if (!productId || quantity == null || quantity <= 0 || price == null || price < 0) {
      return []
    }

    return [
      {
        product_id: productId,
        quantity,
        price,
      },
    ]
  })
}
