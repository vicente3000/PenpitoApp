# ESP32 Kraken Simulator

Simulador local del firmware Kraken para desarrollar y probar la app sin necesidad del hardware.

Se conecta al mismo broker Mosquitto que la app, escucha los comandos en `penpito/kraken/command`, `penpito/pumps/command` y `penpito/motor/command`, y publica estado en `penpito/kraken/state` y `penpito/kraken/presence` con el mismo contrato que el ESP32 real.

## Uso

1. Instala Mosquitto local con WebSocket habilitado en el puerto 9001.
2. En otra terminal, desde la raiz del proyecto:

   ```bash
   node dev/esp_simulator.js
   ```

3. Configura la app para apuntar a tu broker local:

   ```
   EXPO_PUBLIC_MQTT_WS_URL=ws://TU_IP_LOCAL:9001
   ```

4. Inicia Expo y prueba los flujos completos: encendido, preparacion, calibracion, parada de emergencia, sync de sesiones y ordenes.

## Comportamiento

- Replica el ciclo de preparacion (vaso -> hielo -> alcohol -> agitacion -> carbonatado -> listo) con 3 segundos por paso.
- Implementa `penpito/kraken/request_state`: la app lo publica tras reconectar y el simulador responde con el estado actual.
- Publica `presence` con `online` al conectar y retained en `state`/`presence` para que un cliente que se conecte tarde reciba el ultimo estado.
- Acepta los comandos `POWER` (ON/OFF), `PREPARE` (`val=recipeId`, opcional `iceCount`) y `TAKEN` (cuando el usuario retira el vaso).
- Devuelve ACK en `penpito/<topic>/ack` con `{ requestId, ok, state }`.

## Notas

- Este script vive fuera de `src/` y no se compila con la app. Es solo una herramienta de desarrollo.
- Si tu Node no trae `WebSocket` nativo (>= 21), el script usa la dependencia `ws` que ya esta en `node_modules/`.
