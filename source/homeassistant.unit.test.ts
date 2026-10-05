import type { Notification } from '@2bad/onvif-events'
import { describe, expect, it } from 'vitest'
import { eventConfig, eventStates, slug, snapshotConfig, streamConfig } from './homeassistant.ts'

const notification = (
  path: string[],
  data: Record<string, string>,
  source: Record<string, string> = {}
): Notification => ({
  topic: { expression: `tns1:${path.join('/')}`, dialect: '', namespace: undefined, path },
  utcTime: new Date('2026-10-05T09:12:44Z'),
  propertyOperation: 'Changed',
  source,
  key: {},
  data,
  message: {} as Notification['message']
})

const topics = { baseTopic: 'onvif-mqtt', discoveryPrefix: 'homeassistant' }
const camera = { id: 'abc123', name: 'Gate', manufacturer: 'DVC', model: 'DCN-BM2220LPR', firmwareVersion: '5.1' }

describe('slug', () => {
  it('should lowercase and replace other characters with underscores', () => {
    expect(slug('VideoSource_token-1 ')).toBe('videosource_token_1')
  })

  it('should return an empty string when nothing is left', () => {
    expect(slug('--')).toBe('')
  })
})

describe('eventStates', () => {
  it('should read cell motion as a motion sensor per source', () => {
    const states = eventStates(
      notification(['RuleEngine', 'CellMotionDetector', 'Motion'], { IsMotion: 'true' }, { Token: 'VideoSource_1' })
    )
    expect(states).toEqual([
      {
        objectId: 'ruleengine_cellmotiondetector_motion_ismotion_videosource_1',
        name: 'Motion',
        deviceClass: 'motion',
        on: true
      }
    ])
  })

  it('should name the sensor after the topic before a service suffix', () => {
    const [state] = eventStates(
      notification(['VideoSource', 'GlobalSceneChange', 'AnalyticsService'], { State: 'false' })
    )
    expect(state).toMatchObject({ name: 'Global Scene Change', deviceClass: 'tamper', on: false })
  })

  it('should mark image quality events as problems', () => {
    const [state] = eventStates(notification(['VideoSource', 'ImageTooBlurry', 'ImagingService'], { State: 'true' }))
    expect(state).toMatchObject({ name: 'Image Too Blurry', deviceClass: 'problem' })
  })

  it('should read relay states', () => {
    const [state] = eventStates(notification(['Device', 'Trigger', 'Relay'], { LogicalState: 'active' }))
    expect(state).toMatchObject({ name: 'Relay', deviceClass: undefined, on: true })
  })

  it('should add the data key to the name when an event has several states', () => {
    const states = eventStates(notification(['Device', 'Trigger', 'Inputs'], { First: 'true', Second: 'inactive' }))
    expect(states.map((state) => state.name)).toEqual(['Inputs First', 'Inputs Second'])
  })

  it('should skip data that is not on or off', () => {
    expect(eventStates(notification(['RecordingConfig', 'JobState'], { State: 'idle' }))).toEqual([])
  })

  it('should skip events without a topic', () => {
    expect(eventStates({ ...notification([], { State: 'true' }), topic: undefined })).toEqual([])
  })
})

describe('discovery configs', () => {
  it('should link an event sensor to the camera device and both availability topics', () => {
    const config = eventConfig(topics, camera, { objectId: 'motion', name: 'Motion', deviceClass: 'motion', on: true })
    expect(config).toEqual({
      unique_id: 'onvif_abc123_motion',
      availability: [{ topic: 'onvif-mqtt/status' }, { topic: 'onvif-mqtt/abc123/status' }],
      availability_mode: 'all',
      device: {
        identifiers: ['onvif_abc123'],
        name: 'Gate',
        manufacturer: 'DVC',
        model: 'DCN-BM2220LPR',
        sw_version: '5.1'
      },
      name: 'Motion',
      state_topic: 'onvif-mqtt/abc123/event/motion',
      payload_on: 'ON',
      payload_off: 'OFF',
      device_class: 'motion'
    })
  })

  it('should leave out the device class when there is none', () => {
    const config = eventConfig(topics, camera, { objectId: 'relay', name: 'Relay', deviceClass: undefined, on: true })
    expect(config).not.toHaveProperty('device_class')
  })

  it('should point the camera entity at the snapshot topic', () => {
    expect(snapshotConfig(topics, camera)).toMatchObject({ topic: 'onvif-mqtt/abc123/snapshot' })
  })

  it('should publish the stream URL as a diagnostic sensor', () => {
    expect(streamConfig(topics, camera)).toMatchObject({
      state_topic: 'onvif-mqtt/abc123/stream_url',
      entity_category: 'diagnostic'
    })
  })
})
