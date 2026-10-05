import type { Notification } from '@2bad/onvif-events'

export type Topics = {
  baseTopic: string
  discoveryPrefix: string
}

export type CameraIdentity = {
  id: string
  name: string
  manufacturer: string
  model: string
  firmwareVersion: string
}

export type EventState = {
  objectId: string
  name: string
  deviceClass: string | undefined
  on: boolean
}

export const slug = (value: string): string =>
  value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '')

const words = (name: string): string => name.replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')

const ON = new Set(['true', 'active'])
const OFF = new Set(['false', 'inactive'])

const deviceClass = (path: string[]): string | undefined => {
  if (path.some((segment) => segment.includes('Motion'))) return 'motion'
  if (path.some((segment) => segment.includes('Tamper') || segment === 'GlobalSceneChange')) return 'tamper'
  if (path.some((segment) => segment.startsWith('ImageToo'))) return 'problem'
  return undefined
}

/**
 * Read the on and off states an event carries, one per data item whose value is `true`, `false`, `active` or `inactive`.
 *
 * @param notification - A decoded event
 * @returns One state per boolean data item, empty for events without one
 */
export const eventStates = (notification: Notification): EventState[] => {
  const path = notification.topic?.path ?? []
  const last = path.findLast((segment) => !segment.endsWith('Service'))
  if (last === undefined) return []
  const booleans = Object.entries(notification.data).filter(([, value]) => ON.has(value) || OFF.has(value))
  const sources = Object.values(notification.source)
  return booleans.map(([key, value]) => ({
    objectId: slug([...path, key, ...sources].join('_')),
    name: booleans.length > 1 ? `${words(last)} ${words(key)}` : words(last),
    deviceClass: deviceClass(path),
    on: ON.has(value)
  }))
}

export const bridgeStatusTopic = ({ baseTopic }: Topics): string => `${baseTopic}/status`

export const cameraTopic = ({ baseTopic }: Topics, id: string, name: string): string => `${baseTopic}/${id}/${name}`

export const discoveryTopic = ({ discoveryPrefix }: Topics, component: string, id: string, objectId: string): string =>
  `${discoveryPrefix}/${component}/${id}/${objectId}/config`

const common = (topics: Topics, camera: CameraIdentity, objectId: string) => ({
  unique_id: `onvif_${camera.id}_${objectId}`,
  availability: [{ topic: bridgeStatusTopic(topics) }, { topic: cameraTopic(topics, camera.id, 'status') }],
  availability_mode: 'all',
  device: {
    identifiers: [`onvif_${camera.id}`],
    name: camera.name,
    manufacturer: camera.manufacturer,
    model: camera.model,
    sw_version: camera.firmwareVersion
  }
})

export const eventConfig = (topics: Topics, camera: CameraIdentity, state: EventState) => ({
  ...common(topics, camera, state.objectId),
  name: state.name,
  state_topic: cameraTopic(topics, camera.id, `event/${state.objectId}`),
  payload_on: 'ON',
  payload_off: 'OFF',
  ...(state.deviceClass === undefined ? {} : { device_class: state.deviceClass })
})

export const snapshotConfig = (topics: Topics, camera: CameraIdentity) => ({
  ...common(topics, camera, 'snapshot'),
  name: 'Snapshot',
  topic: cameraTopic(topics, camera.id, 'snapshot')
})

export const streamConfig = (topics: Topics, camera: CameraIdentity) => ({
  ...common(topics, camera, 'stream_url'),
  name: 'Stream URL',
  state_topic: cameraTopic(topics, camera.id, 'stream_url'),
  entity_category: 'diagnostic',
  icon: 'mdi:cctv'
})
