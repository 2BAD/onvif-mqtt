import type { Notification } from '@2bad/onvif-events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCamera } from './camera.ts'

const onvif = vi.hoisted(() => ({ connect: vi.fn<(options: object) => Promise<unknown>>() }))

vi.mock('@2bad/onvif', () => ({
  Device: { connect: onvif.connect },
  DeviceManagement: { GetDeviceInformation: 'GetDeviceInformation' }
}))
vi.mock('@2bad/onvif-media', () => ({
  media: 'media',
  defaultProfile: (profiles: unknown[]) => profiles[0]
}))
vi.mock('@2bad/onvif-events', () => ({ events: 'events' }))

const settings = { baseTopic: 'onvif-mqtt', discoveryPrefix: 'homeassistant', snapshotIntervalSeconds: 1 }
const config = { name: 'Gate', host: '192.0.2.10', port: undefined, username: 'admin', password: 'secret' }

const motion = (isMotion: boolean): Notification => ({
  topic: {
    expression: 'tns1:RuleEngine/CellMotionDetector/Motion',
    dialect: '',
    namespace: undefined,
    path: ['RuleEngine', 'CellMotionDetector', 'Motion']
  },
  utcTime: new Date('2026-10-05T09:12:44Z'),
  propertyOperation: 'Changed',
  source: { VideoSourceConfigurationToken: 'vsc1' },
  key: {},
  data: { IsMotion: String(isMotion) },
  message: {} as Notification['message']
})

type Subscribe = (options: {
  signal: AbortSignal
  onError: (error: Error) => void
}) => Promise<AsyncIterable<Notification>>

const subscriptionOf =
  (notifications: Notification[], end?: Error): Subscribe =>
  async ({ signal }) => ({
    async *[Symbol.asyncIterator]() {
      yield* notifications
      if (end) throw end
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    }
  })

const fakeDevice = (overrides: { subscribe?: Subscribe; fetchSnapshot?: () => Promise<Uint8Array> } = {}) => {
  const device = {
    address: new URL('http://192.0.2.10/onvif/device_service'),
    call: vi.fn<() => Promise<Record<string, string>>>().mockResolvedValue({
      manufacturer: 'DVC',
      model: 'DCN-BM2220LPR',
      firmwareVersion: '5.1',
      serialNumber: 'SN-001'
    }),
    use: () => device,
    [Symbol.dispose]: vi.fn<() => void>(),
    media: {
      getProfiles: vi.fn<() => Promise<object[]>>().mockResolvedValue([{ token: 'profile1' }]),
      getStreamUri: vi.fn<() => Promise<object>>().mockResolvedValue({ uri: new URL('rtsp://192.0.2.10:554/stream1') }),
      getSnapshotUri: vi
        .fn<() => Promise<object>>()
        .mockResolvedValue({ uri: new URL('http://192.0.2.10/snapshot.jpg') }),
      fetchSnapshot: vi.fn<() => Promise<Uint8Array>>(
        overrides.fetchSnapshot ?? (async () => new Uint8Array([0xff, 0xd8]))
      )
    },
    events: { subscribe: vi.fn<Subscribe>(overrides.subscribe ?? subscriptionOf([motion(true)])) }
  }
  return device
}

const recorder = () => {
  const messages: { topic: string; payload: string | Uint8Array; retain: boolean }[] = []
  const publish = (topic: string, payload: string | Uint8Array, retain: boolean) => {
    messages.push({ topic, payload, retain })
  }
  const payloadOf = (topic: string) => messages.findLast((message) => message.topic === topic)?.payload
  return { messages, publish, payloadOf }
}

describe('runCamera', () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    onvif.connect.mockReset()
  })

  it('should publish the stream URL, snapshots and event states for a connected camera', async () => {
    const device = fakeDevice()
    onvif.connect.mockResolvedValue(device)
    const { publish, payloadOf, messages } = recorder()
    const controller = new AbortController()
    const running = runCamera(config, settings, publish, controller.signal)

    await vi.waitFor(() =>
      expect(payloadOf('onvif-mqtt/sn_001/event/ruleengine_cellmotiondetector_motion_ismotion_vsc1')).toBe('ON')
    )
    await vi.waitFor(() => expect(payloadOf('onvif-mqtt/sn_001/snapshot')).toEqual(new Uint8Array([0xff, 0xd8])))
    controller.abort()
    await running

    expect(onvif.connect).toHaveBeenCalledWith(expect.objectContaining({ hostname: '192.0.2.10', username: 'admin' }))
    expect(payloadOf('onvif-mqtt/sn_001/stream_url')).toBe('rtsp://192.0.2.10:554/stream1')
    expect(
      JSON.parse(
        String(
          payloadOf('homeassistant/binary_sensor/sn_001/ruleengine_cellmotiondetector_motion_ismotion_vsc1/config')
        )
      )
    ).toMatchObject({
      name: 'Motion',
      device_class: 'motion',
      device: { name: 'Gate', model: 'DCN-BM2220LPR' }
    })
    expect(payloadOf('homeassistant/camera/sn_001/snapshot/config')).toBeDefined()
    expect(payloadOf('homeassistant/sensor/sn_001/stream_url/config')).toBeDefined()
    expect(JSON.parse(String(payloadOf('onvif-mqtt/sn_001/events')))).toMatchObject({
      topic: 'tns1:RuleEngine/CellMotionDetector/Motion',
      data: { IsMotion: 'true' }
    })
    const statuses = messages
      .filter((message) => message.topic === 'onvif-mqtt/sn_001/status')
      .map((message) => message.payload)
    expect(statuses).toEqual(['online', 'offline'])
    expect(device[Symbol.dispose]).toHaveBeenCalled()
  })

  it('should announce each event sensor once', async () => {
    onvif.connect.mockResolvedValue(fakeDevice({ subscribe: subscriptionOf([motion(true), motion(false)]) }))
    const { publish, payloadOf, messages } = recorder()
    const controller = new AbortController()
    const running = runCamera(config, { ...settings, snapshotIntervalSeconds: 0 }, publish, controller.signal)

    const stateTopic = 'onvif-mqtt/sn_001/event/ruleengine_cellmotiondetector_motion_ismotion_vsc1'
    await vi.waitFor(() => expect(payloadOf(stateTopic)).toBe('OFF'))
    controller.abort()
    await running

    expect(messages.filter((message) => message.topic.startsWith('homeassistant/binary_sensor/'))).toHaveLength(1)
    expect(payloadOf('homeassistant/camera/sn_001/snapshot/config')).toBeUndefined()
  })

  it('should keep publishing snapshots when the camera has no events', async () => {
    onvif.connect.mockResolvedValue(fakeDevice({ subscribe: () => Promise.reject(new Error('no events service')) }))
    const { publish, payloadOf } = recorder()
    const controller = new AbortController()
    const running = runCamera(config, settings, publish, controller.signal)

    await vi.waitFor(() => expect(payloadOf('onvif-mqtt/sn_001/snapshot')).toBeDefined())
    expect(payloadOf('onvif-mqtt/sn_001/status')).toBe('online')
    controller.abort()
    await running
    expect(payloadOf('onvif-mqtt/sn_001/status')).toBe('offline')
  })

  it('should skip the stream URL and snapshots when the camera has no media profiles', async () => {
    const device = fakeDevice()
    device.media.getProfiles.mockRejectedValue(new Error('no media service'))
    onvif.connect.mockResolvedValue(device)
    const { publish, payloadOf } = recorder()
    const controller = new AbortController()
    const running = runCamera(config, settings, publish, controller.signal)

    await vi.waitFor(() => expect(payloadOf('onvif-mqtt/sn_001/status')).toBe('online'))
    controller.abort()
    await running
    expect(payloadOf('onvif-mqtt/sn_001/stream_url')).toBeUndefined()
    expect(device.media.getSnapshotUri).not.toHaveBeenCalled()
  })

  it('should keep the session when a snapshot fails', async () => {
    onvif.connect.mockResolvedValue(fakeDevice({ fetchSnapshot: () => Promise.reject(new Error('HTTP 500')) }))
    const { publish, payloadOf } = recorder()
    const controller = new AbortController()
    const running = runCamera(config, settings, publish, controller.signal)

    await vi.waitFor(() =>
      expect(payloadOf('onvif-mqtt/sn_001/event/ruleengine_cellmotiondetector_motion_ismotion_vsc1')).toBe('ON')
    )
    controller.abort()
    await running
    expect(onvif.connect).toHaveBeenCalledTimes(1)
    expect(payloadOf('onvif-mqtt/sn_001/snapshot')).toBeUndefined()
  })

  it('should use the host as id and the model as name when the camera reports no serial number', async () => {
    const device = fakeDevice()
    device.call.mockResolvedValue({
      manufacturer: 'DVC',
      model: 'DCN-BM2220LPR',
      firmwareVersion: '5.1',
      serialNumber: ''
    })
    onvif.connect.mockResolvedValue(device)
    const { publish, payloadOf } = recorder()
    const controller = new AbortController()
    const running = runCamera({ ...config, name: undefined }, settings, publish, controller.signal)

    await vi.waitFor(() => expect(payloadOf('onvif-mqtt/192_0_2_10/status')).toBe('online'))
    controller.abort()
    await running
    expect(JSON.parse(String(payloadOf('homeassistant/sensor/192_0_2_10/stream_url/config')))).toMatchObject({
      device: { name: 'DVC DCN-BM2220LPR' }
    })
  })

  it('should reconnect with a growing delay after failures', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    onvif.connect.mockRejectedValue(new Error('connect ECONNREFUSED'))
    const { publish } = recorder()
    const controller = new AbortController()
    const running = runCamera(config, settings, publish, controller.signal)

    await vi.advanceTimersByTimeAsync(0)
    expect(onvif.connect).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(onvif.connect).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(onvif.connect).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(onvif.connect).toHaveBeenCalledTimes(3)

    controller.abort()
    await running
  })

  it('should publish offline and reconnect when the subscription fails', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    onvif.connect.mockResolvedValue(fakeDevice({ subscribe: subscriptionOf([], new Error('credentials rejected')) }))
    const { publish, payloadOf } = recorder()
    const controller = new AbortController()
    const running = runCamera(config, { ...settings, snapshotIntervalSeconds: 0 }, publish, controller.signal)

    await vi.advanceTimersByTimeAsync(0)
    expect(payloadOf('onvif-mqtt/sn_001/status')).toBe('offline')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(onvif.connect).toHaveBeenCalledTimes(2)

    controller.abort()
    await running
  })

  it('should stop without connecting when the signal is already aborted', async () => {
    const { publish } = recorder()
    await runCamera(config, settings, publish, AbortSignal.abort())
    expect(onvif.connect).not.toHaveBeenCalled()
  })
})
