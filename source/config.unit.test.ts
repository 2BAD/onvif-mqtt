import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigError, loadConfig, parseConfig, supervisorMqtt } from './config.ts'

const camera = { host: '192.0.2.10', username: 'admin', password: 'secret' }

describe('parseConfig', () => {
  it('should fill in the defaults', () => {
    expect(parseConfig({ mqtt_url: 'mqtt://broker.example:1883', cameras: [camera] })).toEqual({
      mqtt: { url: 'mqtt://broker.example:1883', username: undefined, password: undefined },
      baseTopic: 'onvif-mqtt',
      discoveryPrefix: 'homeassistant',
      snapshotIntervalSeconds: 10,
      cameras: [{ name: undefined, host: '192.0.2.10', port: undefined, username: 'admin', password: 'secret' }]
    })
  })

  it('should read every option', () => {
    const config = parseConfig({
      mqtt_url: 'mqtts://broker.example:8883',
      mqtt_username: 'bridge',
      mqtt_password: 'secret',
      base_topic: 'cameras',
      discovery_prefix: 'ha',
      snapshot_interval: 0,
      cameras: [{ ...camera, name: 'Gate', port: 8000 }]
    })
    expect(config).toMatchObject({
      mqtt: { url: 'mqtts://broker.example:8883', username: 'bridge', password: 'secret' },
      baseTopic: 'cameras',
      discoveryPrefix: 'ha',
      snapshotIntervalSeconds: 0,
      cameras: [{ name: 'Gate', port: 8000 }]
    })
  })

  it('should treat empty strings as not set', () => {
    const config = parseConfig({
      mqtt_url: 'mqtt://broker.example',
      base_topic: '',
      cameras: [{ ...camera, name: '' }]
    })
    expect(config.baseTopic).toBe('onvif-mqtt')
    expect(config.cameras[0]?.name).toBeUndefined()
  })

  it('should use the Supervisor broker when mqtt_url is not set', () => {
    const broker = { url: 'mqtt://core-mosquitto:1883', username: 'addons', password: 'secret' }
    expect(parseConfig({ cameras: [camera] }, broker).mqtt).toBe(broker)
  })

  it('should prefer mqtt_url over the Supervisor broker', () => {
    const broker = { url: 'mqtt://core-mosquitto:1883', username: undefined, password: undefined }
    expect(parseConfig({ mqtt_url: 'mqtt://broker.example', cameras: [camera] }, broker).mqtt.url).toBe(
      'mqtt://broker.example'
    )
  })

  it.each([
    [null, 'options must be an object'],
    [{ cameras: [camera] }, 'mqtt_url is required'],
    [{ mqtt_url: 'mqtt://b', cameras: [] }, 'cameras must list at least one camera'],
    [{ mqtt_url: 'mqtt://b' }, 'cameras must list at least one camera'],
    [{ mqtt_url: 'mqtt://b', cameras: ['192.0.2.10'] }, 'cameras[0] must be an object'],
    [{ mqtt_url: 'mqtt://b', cameras: [{ username: 'admin' }] }, 'cameras[0].host is required'],
    [{ mqtt_url: 'mqtt://b', cameras: [{ host: 10 }] }, 'cameras[0].host must be a string'],
    [
      { mqtt_url: 'mqtt://b', cameras: [{ host: 'a', port: 70_000 }] },
      'cameras[0].port must be an integer from 1 to 65535'
    ],
    [
      { mqtt_url: 'mqtt://b', snapshot_interval: 1.5, cameras: [camera] },
      'snapshot_interval must be an integer from 0 to 86400'
    ]
  ])('should reject %j', (options, message) => {
    expect(() => parseConfig(options)).toThrow(new ConfigError(message))
  })

  it('should not put passwords in errors', () => {
    expect(() => parseConfig({ mqtt_url: 'mqtt://b', cameras: [{ password: 'hunter2' }] })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('hunter2') })
    )
  })
})

describe('supervisorMqtt', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const stubFetch = (status: number, body: unknown) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status }))
    vi.stubGlobal('fetch', fetch)
    return fetch
  }

  it('should build the broker URL from the Supervisor service', async () => {
    const fetch = stubFetch(200, {
      data: { host: 'core-mosquitto', port: 1883, ssl: false, username: 'addons', password: 'secret' }
    })
    await expect(supervisorMqtt('token')).resolves.toEqual({
      url: 'mqtt://core-mosquitto:1883',
      username: 'addons',
      password: 'secret'
    })
    expect(fetch).toHaveBeenCalledWith('http://supervisor/services/mqtt', {
      headers: { Authorization: 'Bearer token' }
    })
  })

  it('should use mqtts when the broker has TLS', async () => {
    stubFetch(200, { data: { host: 'core-mosquitto', port: 8883, ssl: true } })
    await expect(supervisorMqtt('token')).resolves.toEqual({
      url: 'mqtts://core-mosquitto:8883',
      username: undefined,
      password: undefined
    })
  })

  it('should return undefined when the Supervisor has no broker', async () => {
    stubFetch(400, { result: 'error' })
    await expect(supervisorMqtt('token')).resolves.toBeUndefined()
  })

  it.each([[{}], [{ data: { host: 'core-mosquitto' } }], [[]]])('should return undefined for %j', async (body) => {
    stubFetch(200, body)
    await expect(supervisorMqtt('token')).resolves.toBeUndefined()
  })
})

describe('loadConfig', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const optionsFile = async (options: unknown) => {
    const file = join(await mkdtemp(join(tmpdir(), 'onvif-mqtt-')), 'options.json')
    await writeFile(file, JSON.stringify(options))
    return file
  }

  it('should read the file named by CONFIG_FILE', async () => {
    const file = await optionsFile({ mqtt_url: 'mqtt://broker.example', cameras: [camera] })
    await expect(loadConfig({ CONFIG_FILE: file })).resolves.toMatchObject({ mqtt: { url: 'mqtt://broker.example' } })
  })

  it('should ask the Supervisor for the broker when SUPERVISOR_TOKEN is set', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response(JSON.stringify({ data: { host: 'core-mosquitto', port: 1883 } })))
    )
    const file = await optionsFile({ cameras: [camera] })
    await expect(loadConfig({ CONFIG_FILE: file, SUPERVISOR_TOKEN: 'token' })).resolves.toMatchObject({
      mqtt: { url: 'mqtt://core-mosquitto:1883' }
    })
  })
})
