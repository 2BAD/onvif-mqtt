type Level = 'info' | 'warn' | 'error'

const describe = (error: unknown): Record<string, unknown> => {
  if (!(error instanceof Error)) return { message: String(error) }
  const { host, service, action } = error as Error & Record<string, unknown>
  return { name: error.name, message: error.message, host, service, action }
}

const write = (level: Level, message: string, fields: Record<string, unknown> = {}): void => {
  const { error, ...rest } = fields
  const entry = {
    time: new Date().toISOString(),
    level,
    message,
    ...rest,
    ...(error === undefined ? {} : { error: describe(error) })
  }
  process.stdout.write(`${JSON.stringify(entry)}\n`)
}

export const log = {
  info: (message: string, fields?: Record<string, unknown>) => write('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write('error', message, fields)
}
