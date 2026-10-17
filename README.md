# Caneca IoT · servidor del monitor

Servidor en Node.js de la caneca clasificadora: recibe la cámara de la ESP32-CAM por WebSocket, le pregunta a
Gemini qué residuo es, le dice a la caneca a qué lado inclinar la bandeja y sirve el monitor en línea.

- **Monitor** en cuatro pestañas (arriba en el PC, abajo en el celular): **En vivo** (cámara, botones de cada lado y
  sensores con medidores), **Calibrar**, **Análisis** e **Historial** con la foto de cada clasificación.
- **Control:** todos miran; con el PIN maneja **una sola persona**. Si otra pone el PIN queda en fila y el control
  le pasa cuando la primera toca "Terminar", cierra la página o lleva 3 minutos sin tocar nada mientras alguien espera.
  Cuando un botón está bloqueado, la página dice por qué.
- **Calibrar:** bandeja vacía guardada, lo que ve ahora y qué cambió, en 4 pasos (bandeja vacía, zona, sensibilidad,
  qué decide). La zona se arrastra en la imagen y la sensibilidad se prueba con una regla: todo se ve al instante y la
  caneca lo usa al tocar **Guardar en la caneca** (necesita el control). Se guardan capturas ("No lo detectó",
  "Detectó algo con la bandeja vacía", "Lo clasificó mal") para revisarlas después.
- **Lados:** aprovechables = 150° (lado del 180), no aprovechables = 30° (lado del 0). Vaciar va por separado a cada lado.

> El archivo `.env` con la clave de Gemini **no está en este repositorio** (y no debe subirse nunca).
> Sus valores van en las variables de entorno del hosting.

## Subirlo a Hostinger desde GitHub

1. hPanel → **Sitios web** → **Agregar sitio web** → **Web App (Node.js)** → **Importar desde GitHub**.
   Autoriza a Hostinger a ver tus repositorios y elige **Nharenn/caneca-iot**, rama **main**.
2. Configuración de compilación:
   - Framework: **Express** (u "Otro").
   - Versión de Node: **22**.
   - Archivo de entrada: **server.js**.
   - Comando de build: ninguno (Hostinger corre `npm install` solo).
3. **Variables de entorno** (cópialas de `3_codigo/servidor/.env` en tu Mac):

   | Variable | Valor |
   |---|---|
   | `TOKEN_DISPOSITIVO` | el mismo del `.env` (y del programa de la placa) |
   | `PIN_CONTROL` | el PIN del monitor |
   | `GEMINI_API_KEY` | tu clave de Google AI Studio |
   | `MODO_PRUEBA` | `0` |
   | `RESOLUCION_IA` | `baja` |

   El puerto no se pone: el servidor usa el `PORT` que da el hosting.
4. **Deploy**. Cada vez que se suba un cambio a `main`, Hostinger lo vuelve a desplegar solo.
5. Revisa en el navegador:
   - `https://TU-DOMINIO/api/salud` → `"ok":true` y, en `config`, `token`, `pin` y `claveIA` en `true`.
   - `https://TU-DOMINIO/` → el monitor. Arriba debe decir **Caneca sin conexión** (servidor bien, falta la placa).
6. Pásale el dominio a Claude: lo deja **guardado de fábrica** en el programa de la placa, así nadie tiene que
   escribir servidores. Se carga el programa una vez y listo.

### Si el monitor se queda en "Conectando con el servidor…"

El monitor y la placa hablan por **WebSocket**. Hostinger dice que sus planes Web y Cloud solo permiten WebSockets
de salida; las Web Apps de Node.js podrían dejarlos pasar, pero hay que probarlo (paso 5). Si no conecta, este mismo
repositorio funciona en un **VPS** (Hostinger u otro) o en otro hosting de Node.js con WebSockets:

```bash
npm install --omit=dev
npm start            # o, para que quede siempre prendido: npx pm2 start server.js --name caneca
```

En un VPS pon delante un proxy con HTTPS (Nginx o Caddy) que pase `/ws/` con `Upgrade` y `Connection`.

## Probarlo en tu computador

```bash
npm install
cp .env.example .env      # y pon los valores reales
npm start                 # monitor en http://localhost:3000
node herramientas/simular-caneca.js   # (otra terminal) una caneca de mentira, sin hardware
```

`npm run prueba` clasifica al azar, sin gastar la API.

## Archivos

| Archivo | Para qué |
|---|---|
| `server.js` | Servidor: monitor, WebSockets con la placa, control con fila, depuración y consulta a Gemini |
| `public/` | La página del monitor (`index.html`, `app.js`, `estilos.css`) |
| `clases.json` | Qué reconoce la IA y a qué caneca va cada cosa |
| `herramientas/simular-caneca.js` | Simula la placa para probar sin hardware |
| `.env.example` | La configuración, sin claves |

El CDN de Hostinger guarda `app.js` y `estilos.css`; por eso el servidor arma la página con `?v=<huella>` en esas dos direcciones y cada cambio llega al navegador sin quedarse con la versión vieja.

Los datos (conteos, historial, fotos y capturas) se guardan en `datos/`; en el hosting pueden borrarse al volver a desplegar.
La página y el servidor llevan la misma versión (`2026-10-17.7`). El programa de la placa va por su cuenta (`2026-10-17.5`): si la placa tiene uno más viejo, el monitor lo avisa en Sensores y en Calibrar.
