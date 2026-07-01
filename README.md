# PenpitoApp

Aplicacion movil para operar Penpito, una coctelera automatica conectada a un ESP32. Esta hecha con Expo, React Native, Expo Router y TypeScript.

La app permite escanear codigos QR de mesa, mesero o administrador, tomar pedidos, preparar tragos, seguir el estado de la maquina, administrar inventario, ajustar precios y parametros de dispensado, y comunicarse con el firmware del ESP32 mediante MQTT/Mosquitto.

## Requisitos

Antes de iniciar la app necesitas:

- Node.js y npm.
- Git.
- Expo Go en el telefono, si quieres probar en un dispositivo fisico.
- Android Studio, si quieres usar emulador Android.
- Xcode, solo si vas a correr iOS en macOS.
- PlatformIO, si vas a compilar o subir el firmware del ESP32.

Para verificar Node y npm:

```bash
node -v
npm -v
```

## Instalacion

Clona el repositorio y entra a la carpeta:

```bash
git clone https://github.com/vicente3000/PenpitoApp.git
cd PenpitoApp
```

Instala las dependencias:

```bash
npm install
```

## Iniciar la app

Para iniciar Expo:

```bash
npm start
```

Luego puedes:

- Escanear el QR con Expo Go desde el celular.
- Presionar `a` para abrir Android.
- Presionar `i` para abrir iOS, solo en macOS.
- Presionar `w` para abrir la version web.

Tambien puedes iniciar directamente una plataforma:

```bash
npm run android
npm run ios
npm run web
```

## Scripts disponibles

- `npm start`: inicia Expo.
- `npm run android`: inicia Expo y abre Android.
- `npm run ios`: inicia Expo y abre iOS.
- `npm run web`: inicia Expo en modo web.

## Acceso por QR

La pantalla inicial lee codigos QR con estos formatos:

- Mesa: `PENPITO:MESA:07`
- Mesero: `PENPITO:MESERO`
- Administrador: `PENPITO:ADMIN`

Cada tipo de QR abre un flujo distinto:

- Mesa: permite a un cliente unirse a una mesa, elegir tragos, agregar pedidos al carrito, escoger division de cuenta y propina.
- Mesero: muestra pedidos por mesa, pedidos listos, pedidos en preparacion y acciones como marcar servido o eliminar pedidos pendientes.
- Administrador: permite ajustar parametros, precios e inventario. La clave actual es `admin123`.

## Funciones principales

- Carta de tragos con imagenes y precios configurables.
- Pedidos por mesa y por invitado.
- Cola de preparacion automatica.
- Seguimiento de pasos de preparacion: vaso, hielo, alcohol, agitacion, carbonatado y listo.
- Piscola con intensidad suave, normal o fuerte.
- Control de inventario por botella y validacion de stock.
- Repositorios locales con soporte para `expo-sqlite`.
- Persistencia web mediante la implementacion local correspondiente.

## Comunicacion con Kraken

La app usa por defecto `KrakenMqttAdapter` y se comunica mediante Mosquitto:

```ts
export const deviceService = new DeviceService(new KrakenMqttAdapter());
```

Flujo esperado:

```text
App movil -- MQTT por WebSocket --> Mosquitto -- MQTT TCP --> ESP32
```

Topics generales usados:

- `penpito/kraken/state`: estado publicado por el ESP32.
- `penpito/kraken/command`: comandos `POWER`, `PREPARE` y `CLEAN`.
- `penpito/kraken/command/ack`: confirmacion de comandos.

Topics por placa para configuracion:

- `penpito/pumps/command`: configuracion del ESP32 de bombas.
- `penpito/motor/command`: configuracion del ESP32 del motor.
- `penpito/pumps/command/ack` y `penpito/motor/command/ack`: confirmacion.

La app se conecta por WebSocket al broker:

```bash
EXPO_PUBLIC_MQTT_WS_URL=ws://IP_DEL_BROKER:9001
```

El ESP32 se conecta por MQTT TCP. Para subir el firmware a cada placa, cambia en `Codigo esp32 probar/src/main.cpp`:

```cpp
const char* DEVICE_ID = "pumps"; // "pumps" para bombas, "motor" para motor
const char* DEFAULT_WIFI_SSID = "TU_WIFI";
const char* DEFAULT_WIFI_PASSWORD = "TU_CLAVE_WIFI";
const char* DEFAULT_MQTT_HOST = "IP_DEL_BROKER";
const uint16_t DEFAULT_MQTT_PORT = 1883;
```

Despues, desde la pagina de administrador de la app puedes enviar nuevos datos de WiFi/MQTT a cada ESP32. El ESP32 guarda esos datos en memoria NVS y reinicia para entrar a la nueva red.

Mosquitto debe tener un listener TCP para el ESP32 y uno WebSocket para la app:

```conf
listener 1883 0.0.0.0
allow_anonymous true

listener 9001 0.0.0.0
protocol websockets
allow_anonymous true
```

El adaptador simulado sigue disponible en `src/adapters/MockAdapter.ts` para desarrollo sin hardware. Para usarlo, cambia la instancia exportada en `src/services/DeviceService.ts`.

## Firmware ESP32

El firmware del ESP32 esta en:

```bash
Codigo esp32 probar/
```

Es un proyecto PlatformIO para la placa `esp32dev`, con framework Arduino y dependencias `ESP32Servo`, `ArduinoJson` y `PubSubClient`.

Comandos basicos:

```bash
cd "Codigo esp32 probar"
pio run
pio run --target upload
pio device monitor
```

Si usas la extension de PlatformIO en VS Code, abre la carpeta `Codigo esp32 probar/` y usa las acciones de build, upload y monitor desde la barra de PlatformIO.

## Estructura del proyecto

- `app/`: rutas de Expo Router. La app principal vive en el tab inicial.
- `src/screens/`: pantalla principal y flujos de mesa, mesero y administrador.
- `src/components/`: componentes propios, como la linea de tiempo de preparacion.
- `src/services/`: servicios de comunicacion y cola de comandos.
- `src/adapters/`: adaptadores de comunicacion MQTT, HTTP legado y simulado.
- `src/repositories/`: persistencia local de recetas, pedidos, inventario y ajustes.
- `src/stores/`: estado global con Zustand.
- `src/models/`: tipos principales de recetas, pedidos, maquina, sesiones y ajustes.
- `src/utils/`: utilidades para QR, preparacion y configuracion de tragos.
- `assets/`: imagenes, iconos y fuentes.
- `Codigo esp32 probar/`: firmware ESP32 con PlatformIO.
- `docs/`: documentos del proyecto.

## Problemas comunes

### Expo no inicia

Reinstala dependencias:

```bash
npm install
```

Luego reinicia Expo limpiando cache:

```bash
npx expo start -c
```

### La app no conecta con Kraken

Verifica que el telefono, el broker Mosquitto y el ESP32 esten en la misma red.

Si Mosquitto usa otra IP o puerto WebSocket, inicia Expo con:

```bash
EXPO_PUBLIC_MQTT_WS_URL=ws://IP_DEL_BROKER:9001 npm start
```

En PowerShell puedes hacerlo asi:

```powershell
$env:EXPO_PUBLIC_MQTT_WS_URL='ws://IP_DEL_BROKER:9001'
npm start
```

Para abrir directo la vista de administrador durante pruebas, sin QR ni contrasena:

```powershell
$env:EXPO_PUBLIC_ADMIN_TEST_MODE='true'
npm start
```

### No puedo subir el codigo a GitHub

Verifica el remoto:

```bash
git remote -v
```

Si GitHub muestra error `403`, probablemente estas autenticado con una cuenta sin permisos sobre el repositorio.

Puedes cerrar sesion de esa cuenta en Git Credential Manager:

```bash
git credential-manager github logout NOMBRE_DE_USUARIO
```

Luego intenta subir de nuevo:

```bash
git push -u origin main
```

### Git intenta conectarse a 127.0.0.1:9

Si aparece un error parecido a `Failed to connect to 127.0.0.1 port 9`, revisa las variables de proxy. Puedes limpiarlas temporalmente en PowerShell:

```powershell
$env:HTTP_PROXY=''
$env:HTTPS_PROXY=''
$env:ALL_PROXY=''
```

Despues intenta nuevamente:

```bash
git push -u origin main
```

## Tecnologias principales

- Expo 54.
- React Native 0.81.
- React 19.
- Expo Router 6.
- TypeScript.
- Zustand.
- Expo SQLite.
- Expo Camera.
- PlatformIO, Arduino y ESP32 para el firmware Kraken.
