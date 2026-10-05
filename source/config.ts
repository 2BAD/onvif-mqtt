import { readFile } from 'node:fs/promises'

export type CameraConfig = {
  name: string | undefined
  host: string
  port: number | undefined
  username: string | undefined
  password: string | undefined
}

export type MqttConfig = {
  url: string
  username: string | undefined
  password: string | undefined
}

export type Config = {
  mqtt: MqttConfig
  baseTopic: string
  discoveryPrefix: string
  snapshotIntervalSeconds: number
  cameras: CameraConfig[]
}

export class ConfigError extends Error {
  override name = 'ConfigError'
}

type Fields = Record<string, unknown>

const isObject = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const optionalString = (fields: Fields, key: string, path: string): string | undefined => {
  const value = fields[key]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new ConfigError(`${path}${key} must be a string`)
  return value
}

const optionalInteger = (fields: Fields, key: string, path: string, min: number, max: number): number | undefined => {
  const value = fields[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${path}${key} must be an integer from ${min} to ${max}`)
  }
  return value
}

const parseCamera = (value: unknown, index: number): CameraConfig => {
  const path = `cameras[${index}].`
  if (!isObject(value)) throw new ConfigError(`cameras[${index}] must be an object`)
  const host = optionalString(value, 'host', path)
  if (host === undefined) throw new ConfigError(`${path}host is required`)
  return {
    name: optionalString(value, 'name', path),
    host,
    port: optionalInteger(value, 'port', path, 1, 65_535),
    username: optionalString(value, 'username', path),
    password: optionalString(value, 'password', path)
  }
}

/**
 * Validate the options file, written in the snake_case keys of the add-on schema.
 *
 * @param options - Parsed JSON of the options file
 * @param supervisorMqtt - Broker offered by the Home Assistant Supervisor, used when `mqtt_url` is not set
 * @returns The validated configuration
 * @throws {ConfigError} When an option is missing or has the wrong type
 */
export const parseConfig = (options: unknown, supervisorMqtt?: MqttConfig): Config => {
  if (!isObject(options)) throw new ConfigError('options must be an object')
  const url = optionalString(options, 'mqtt_url', '')
  const mqtt =
    url === undefined
      ? supervisorMqtt
      : {
          url,
          username: optionalString(options, 'mqtt_username', ''),
          password: optionalString(options, 'mqtt_password', '')
        }
  if (mqtt === undefined) throw new ConfigError('mqtt_url is required')
  const cameras = options['cameras']
  if (!Array.isArray(cameras) || cameras.length === 0) throw new ConfigError('cameras must list at least one camera')
  return {
    mqtt,
    baseTopic: optionalString(options, 'base_topic', '') ?? 'onvif-mqtt',
    discoveryPrefix: optionalString(options, 'discovery_prefix', '') ?? 'homeassistant',
    snapshotIntervalSeconds: optionalInteger(options, 'snapshot_interval', '', 0, 86_400) ?? 10,
    cameras: cameras.map(parseCamera)
  }
}

/**
 * Ask the Home Assistant Supervisor for the MQTT broker the add-on was given.
 *
 * @param token - Value of `SUPERVISOR_TOKEN`
 * @returns The broker, or `undefined` when the Supervisor offers none
 */
export const supervisorMqtt = async (token: string): Promise<MqttConfig | undefined> => {
  const response = await fetch('http://supervisor/services/mqtt', { headers: { Authorization: `Bearer ${token}` } })
  if (!response.ok) return undefined
  const body: unknown = await response.json()
  if (!isObject(body) || !isObject(body['data'])) return undefined
  const { host, port, ssl, username, password } = body['data']
  if (typeof host !== 'string' || typeof port !== 'number') return undefined
  return {
    url: `${ssl === true ? 'mqtts' : 'mqtt'}://${host}:${port}`,
    username: typeof username === 'string' ? username : undefined,
    password: typeof password === 'string' ? password : undefined
  }
}

/**
 * Read the options file and fill in the Supervisor broker when running as an add-on.
 *
 * @param env - Process environment
 * @returns The validated configuration
 */
export const loadConfig = async (env: NodeJS.ProcessEnv): Promise<Config> => {
  const file = env['CONFIG_FILE'] ?? '/data/options.json'
  const options: unknown = JSON.parse(await readFile(file, 'utf8'))
  const token = env['SUPERVISOR_TOKEN']
  return parseConfig(options, token === undefined ? undefined : await supervisorMqtt(token))
}
