import { connectAsync } from 'mqtt'
import { runCamera } from './camera.ts'
import { loadConfig } from './config.ts'
import { bridgeStatusTopic } from './homeassistant.ts'
import { log } from './log.ts'

const main = async () => {
  const config = await loadConfig(process.env)
  const statusTopic = bridgeStatusTopic(config)

  const client = await connectAsync(config.mqtt.url, {
    ...(config.mqtt.username === undefined ? {} : { username: config.mqtt.username }),
    ...(config.mqtt.password === undefined ? {} : { password: config.mqtt.password }),
    will: { topic: statusTopic, payload: Buffer.from('offline'), retain: true, qos: 1 }
  })
  client.on('error', (error) => log.error('mqtt error', { error }))
  client.on('offline', () => log.warn('mqtt offline'))
  client.on('reconnect', () => log.info('mqtt reconnecting'))

  const publish = async (topic: string, payload: string | Uint8Array, retain: boolean) => {
    const message =
      typeof payload === 'string' ? payload : Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
    try {
      await client.publishAsync(topic, message, { retain, qos: retain ? 1 : 0 })
    } catch (error) {
      log.error('mqtt publish failed', { topic, error })
    }
  }

  const controller = new AbortController()
  for (const name of ['SIGINT', 'SIGTERM'] as const) {
    process.once(name, () => {
      log.info('stopping', { signal: name })
      controller.abort()
    })
  }

  await publish(statusTopic, 'online', true)
  log.info('started', { cameras: config.cameras.length, broker: new URL(config.mqtt.url).host })

  const settings = {
    baseTopic: config.baseTopic,
    discoveryPrefix: config.discoveryPrefix,
    snapshotIntervalSeconds: config.snapshotIntervalSeconds
  }
  await Promise.all(config.cameras.map((camera) => runCamera(camera, settings, publish, controller.signal)))

  await publish(statusTopic, 'offline', true)
  await client.endAsync()
}

try {
  await main()
} catch (error) {
  log.error('stopped', { error })
  process.exitCode = 1
}
