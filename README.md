# onvif-mqtt

ONVIF camera events, snapshots and stream URLs in Home Assistant over MQTT.

Built on [`@2bad/onvif`](https://github.com/2BAD/onvif).

## What you get

Each camera appears as a device in Home Assistant with:

- a binary sensor for each on and off event the camera sends: motion, tamper, digital inputs, relays
- a camera entity with a new snapshot every 10 seconds
- the RTSP stream URL as a diagnostic sensor

Every event is also published as JSON on `onvif-mqtt/<camera id>/events`.

## Home Assistant add-on

1. Open Settings, Add-ons, Add-on Store, then Repositories in the top right menu.
2. Add `https://github.com/2BAD/onvif-mqtt`.
3. Install ONVIF MQTT.
4. Add your cameras on the Configuration tab and start the add-on.

Needs an MQTT broker, such as the Mosquitto broker add-on, and the MQTT integration. The add-on finds the Mosquitto add-on by itself.

## Docker

```sh
docker run -d --name onvif-mqtt --restart unless-stopped \
  -v ./options.json:/data/options.json:ro \
  ghcr.io/2bad/onvif-mqtt:latest
```

```json
{
  "mqtt_url": "mqtt://192.0.2.2:1883",
  "cameras": [{ "name": "Gate", "host": "192.0.2.10", "username": "admin", "password": "secret" }]
}
```

`CONFIG_FILE` sets another path for the options file.

## Options and topics

See [DOCS.md](onvif-mqtt/DOCS.md).

## License

MIT
