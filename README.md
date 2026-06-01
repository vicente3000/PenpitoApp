# PenpitoApp

Aplicacion movil para controlar una coctelera automatica. Esta hecha con Expo, React Native y Expo Router. Incluye pantallas para operar la app, manejar tragos, ajustes, persistencia local y una capa de comunicacion preparada para conectarse con el dispositivo.

El repositorio tambien incluye firmware para ESP32 en la carpeta `firmware/`.

## Requisitos

Antes de iniciar la app necesitas tener instalado:

- Node.js
- npm
- Git
- Expo Go en el telefono, si quieres probar en un dispositivo fisico
- Android Studio, si quieres usar emulador Android
- Xcode, solo si vas a correr iOS en macOS

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

Para iniciar el servidor de desarrollo de Expo:

```bash
npm start
```

Luego puedes:

- Escanear el QR con Expo Go desde el celular.
- Presionar `a` en la terminal para abrir Android.
- Presionar `i` en la terminal para abrir iOS, solo en macOS.
- Presionar `w` para abrir la version web.

Tambien puedes iniciar directamente cada plataforma:

```bash
npm run android
npm run ios
npm run web
```

## Scripts disponibles

```bash
npm start
```

Inicia Expo.

```bash
npm run android
```

Inicia Expo y abre la app en Android.

```bash
npm run ios
```

Inicia Expo y abre la app en iOS.

```bash
npm run web
```

Inicia Expo en modo web.

## Estructura del proyecto

- `app/`: rutas y pantallas base de Expo Router.
- `src/screens/`: pantallas principales de la app.
- `src/components/`: componentes propios de la aplicacion.
- `src/services/`: servicios de comunicacion con el dispositivo.
- `src/adapters/`: adaptadores de comunicacion. Actualmente se usa `MockAdapter` para desarrollo.
- `src/repositories/`: repositorios de datos locales.
- `src/stores/`: estado global con Zustand.
- `src/models/`: modelos y tipos principales.
- `assets/`: imagenes, iconos y fuentes.
- `firmware/`: firmware ESP32 para la coctelera automatica.
- `docs/`: documentos del proyecto.

## Comunicacion con el dispositivo

Durante el desarrollo, la app usa un adaptador simulado:

```ts
export const deviceService = new DeviceService(new MockAdapter());
```

Esto permite probar la app sin tener el hardware conectado. Para conectar el dispositivo real, se debe implementar o activar un adaptador real en `src/adapters/` y reemplazar el `MockAdapter` en `src/services/DeviceService.ts`.

## Base de datos local

La app usa persistencia local mediante repositorios en `src/repositories/`. Tambien incluye soporte para `expo-sqlite`.

## Firmware ESP32

El firmware esta en:

```bash
firmware/
```

Requiere ESP-IDF instalado y configurado.

Comandos basicos:

```bash
cd firmware
idf.py set-target esp32
idf.py build
```

Mas detalles estan en `firmware/README.md`.

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

- Expo
- React Native
- Expo Router
- TypeScript
- Zustand
- Expo SQLite
- ESP-IDF para el firmware del ESP32

