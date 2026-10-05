import { Device, DeviceManagement } from '@2bad/onvif'
import { events } from '@2bad/onvif-events'
import { defaultProfile, type MediaAddress, media, type Profile } from '@2bad/onvif-media'
import type { CameraConfig } from './config.ts'
import {
  type CameraIdentity,
  cameraTopic,
  discoveryTopic,
  eventConfig,
  eventStates,
  slug,
  snapshotConfig,
  streamConfig,
  type Topics
} from './homeassistant.ts'
import { log } from './log.ts'

export type Publish = (topic: string, payload: string | Uint8Array, retain: boolean) => void

export type CameraSettings = Topics & {
  snapshotIntervalSeconds: number
}

const FIRST_RETRY_MS = 5_000
const MAX_RETRY_MS = 300_000
const STABLE_SESSION_MS = 60_000

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })

const aborted = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve()
    signal.addEventListener('abort', () => resolve(), { once: true })
  })

const optional = async <T>(label: string, host: string, task: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await task()
  } catch (error) {
    log.warn(`${label} unavailable`, { camera: host, error })
    return undefined
  }
}

const snapshots = async (
  camera: ReturnType<typeof withServices>,
  address: MediaAddress,
  intervalMs: number,
  topic: string,
  publish: Publish,
  signal: AbortSignal
): Promise<void> => {
  while (!signal.aborted) {
    try {
      publish(topic, await camera.media.fetchSnapshot(address, { signal }), false)
    } catch (error) {
      if (!signal.aborted) log.warn('snapshot failed', { camera: camera.address.host, error })
    }
    await sleep(intervalMs, signal)
  }
}

const withServices = (device: Device) => device.use(media).use(events)

const session = async (config: CameraConfig, settings: CameraSettings, publish: Publish, signal: AbortSignal) => {
  using device = await Device.connect({
    hostname: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    signal
  })
  const info = await device.call(DeviceManagement.GetDeviceInformation, {}, { signal })
  const identity: CameraIdentity = {
    id: slug(info.serialNumber) || slug(config.host),
    name: config.name ?? `${info.manufacturer} ${info.model}`,
    manufacturer: info.manufacturer,
    model: info.model,
    firmwareVersion: info.firmwareVersion
  }
  const camera = withServices(device)
  const topic = (name: string) => cameraTopic(settings, identity.id, name)
  const announce = (component: string, objectId: string, config: object) =>
    publish(discoveryTopic(settings, component, identity.id, objectId), JSON.stringify(config), true)

  const profile: Profile | undefined = defaultProfile(
    (await optional('media profiles', config.host, () => camera.media.getProfiles({ signal }))) ?? []
  )
  if (profile) {
    const stream = await optional('stream URL', config.host, () => camera.media.getStreamUri(profile, { signal }))
    if (stream) {
      announce('sensor', 'stream_url', streamConfig(settings, identity))
      publish(topic('stream_url'), stream.uri.href, true)
    }
  }

  const stop = new AbortController()
  const sessionSignal = AbortSignal.any([signal, stop.signal])
  const tasks: Promise<void>[] = []
  if (profile && settings.snapshotIntervalSeconds > 0) {
    const address = await optional('snapshot URL', config.host, () => camera.media.getSnapshotUri(profile, { signal }))
    if (address) {
      announce('camera', 'snapshot', snapshotConfig(settings, identity))
      const intervalMs = settings.snapshotIntervalSeconds * 1000
      tasks.push(snapshots(camera, address, intervalMs, topic('snapshot'), publish, sessionSignal))
    }
  }

  publish(topic('status'), 'online', true)
  log.info('camera connected', { camera: config.host, id: identity.id, model: info.model })

  try {
    const subscription = await optional('events', config.host, () =>
      camera.events.subscribe({
        onError: (error) => {
          if (!sessionSignal.aborted) log.warn('event subscription recovered', { camera: config.host, error })
        },
        signal: sessionSignal
      })
    )
    if (subscription === undefined) {
      await aborted(sessionSignal)
      return
    }
    const announced = new Set<string>()
    for await (const notification of subscription) {
      publish(
        topic('events'),
        JSON.stringify({
          topic: notification.topic?.expression,
          utcTime: notification.utcTime,
          propertyOperation: notification.propertyOperation,
          source: notification.source,
          data: notification.data
        }),
        false
      )
      for (const state of eventStates(notification)) {
        if (!announced.has(state.objectId)) {
          announce('binary_sensor', state.objectId, eventConfig(settings, identity, state))
          announced.add(state.objectId)
        }
        publish(topic(`event/${state.objectId}`), state.on ? 'ON' : 'OFF', true)
      }
    }
  } finally {
    stop.abort()
    await Promise.all(tasks)
    publish(topic('status'), 'offline', true)
  }
}

/**
 * Keep one camera connected until the signal aborts, reconnecting with backoff after each failure.
 *
 * @param config - The camera from the options file
 * @param settings - Topic prefixes and snapshot interval
 * @param publish - Sends a message to the broker
 * @param signal - Stops the camera
 */
export const runCamera = async (
  config: CameraConfig,
  settings: CameraSettings,
  publish: Publish,
  signal: AbortSignal
): Promise<void> => {
  let delayMs = FIRST_RETRY_MS
  while (!signal.aborted) {
    const started = performance.now()
    try {
      await session(config, settings, publish, signal)
    } catch (error) {
      if (signal.aborted) return
      log.error('camera failed', { camera: config.host, error })
    }
    if (performance.now() - started > STABLE_SESSION_MS) delayMs = FIRST_RETRY_MS
    await sleep(delayMs, signal)
    delayMs = Math.min(delayMs * 2, MAX_RETRY_MS)
  }
}
