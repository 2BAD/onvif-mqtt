# ONVIF MQTT

## Options

```yaml
cameras:
  - host: 192.0.2.10 # host name or IP address of the camera

    # optional, off by default
    name: Gate # device name in Home Assistant, manufacturer and model otherwise
    port: 8000 # ONVIF port, 80 otherwise
    username: admin
    password: secret

# optional, values are the defaults
snapshot_interval: 10 # seconds between snapshots, 0 turns snapshots off
base_topic: onvif-mqtt
discovery_prefix: homeassistant

# optional, off by default
mqtt_url: mqtt://192.0.2.2:1883 # the broker from the Mosquitto add-on otherwise
mqtt_username: bridge
mqtt_password: secret
```

Docker uses the same keys in `/data/options.json`.

## Entities

- **Binary sensors**: one per on and off value in the camera's events. A sensor appears when the camera first sends its event. Most cameras send every event right after connecting.
- **Snapshot**: a camera entity with the latest JPEG.
- **Stream URL**: the RTSP address of the main profile, without credentials.

## Topics

| Topic                                  | Payload                         |
| -------------------------------------- | ------------------------------- |
| `onvif-mqtt/status`                    | `online` or `offline`           |
| `onvif-mqtt/<camera id>/status`        | `online` or `offline`           |
| `onvif-mqtt/<camera id>/event/<event>` | `ON` or `OFF`                   |
| `onvif-mqtt/<camera id>/events`        | every event as JSON             |
| `onvif-mqtt/<camera id>/snapshot`      | JPEG image                      |
| `onvif-mqtt/<camera id>/stream_url`    | `rtsp://192.0.2.10:554/stream1` |

The camera id is the serial number, or the host when the camera reports none.

## Logs

Each log line is JSON. Passwords never appear in the logs.
