// Simula la ESP32-CAM para probar el monitor sin tener el hardware.
// Uso:  node herramientas/simular-caneca.js            (servidor en este computador)
//       node herramientas/simular-caneca.js wss://tu-dominio.com
// Manda la foto herramientas/bandeja.jpg como si fuera la cámara, simula un residuo
// cada 15 s, responde a los botones del monitor igual que la placa y, si alguien abre
// Calibrar, manda miniaturas inventadas (bandeja vacía, ahora y qué cambió). Como la placa 2026-10-17.6:
// si la IA dice "mano" no se mueve, si dice "vacio" retoma la bandeja vacía, después de inclinar avisa si
// el residuo cayó, y "Calibrar con la bandeja vacía" manda las medidas y una foto de referencia.
'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ quiet: true, path: path.join(__dirname, '..', '.env') });
const WebSocket = require('ws');

const VERSION = '2026-10-18.2'; // la del programa de la placa
const base = (process.argv[2] || `ws://localhost:${process.env.PORT || process.env.PUERTO || 3000}`).replace(/\/$/, '');
const token = encodeURIComponent(process.env.TOKEN_DISPOSITIVO || '');
const foto = fs.readFileSync(path.join(__dirname, 'bandeja.jpg'));

// aprovechables = lado del 180 (150°), no aprovechables = lado del 0 (30°)
const placa = {
  stream: false, depurar: false, servo: 90, pausa: false, flash: false, ultra: false, vaciar: null,
  umbralCamara: 3, zona: { x0: 18, x1: 78, y0: 4, y1: 62 }, refDesde: Date.now(), ultraUmbral: 1.5, mano: false, flashFoto: 30,
};
const ws = new WebSocket(`${base}/ws/esp?token=${token}`);

function mandarFoto(tipo) {
  const paquete = Buffer.alloc(foto.length + 1);
  paquete[0] = tipo.charCodeAt(0);
  foto.copy(paquete, 1);
  ws.send(paquete);
}

function mandarEstado() {
  const { ultra, pausa, flash, servo, vaciar } = placa;
  const dist = ultra ? 20.1 : 23.7;
  const camPct = ultra ? 9 : 1; // % de la bandeja distinto a la foto de la bandeja vacía
  ws.send(JSON.stringify({
    t: 'estado', ultra, dist, vacia: 23.7, ultraUmbral: placa.ultraUmbral, cam: ultra, camPct, atascado: false, esperando: false, mano: placa.mano,
    pausa, flash, servo, vaciar: Boolean(vaciar), vaciarLado: vaciar, rssi: -58, ip: '192.168.1.50', fw: VERSION, redPropia: false, modo: 'online',
  }));
}

// Miniaturas de 80 x 60 como las de la placa: un degradado (la bandeja) y, si hay residuo, un "papel"
function mandarDepuracion() {
  const w = 80, h = 60, n = w * h;
  const z = placa.zona;
  const zx0 = Math.round((w * z.x0) / 100), zx1 = Math.round((w * z.x1) / 100);
  const zy0 = Math.round((h * z.y0) / 100), zy1 = Math.round((h * z.y1) / 100);
  const ref = Buffer.alloc(n), cur = Buffer.alloc(n), marcas = Buffer.alloc(n);
  let distintos = 0, total = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const fondo = 120 + Math.round(40 * (x / w)) + ((x * 7 + y * 13) % 5);
      ref[i] = fondo;
      const papel = placa.ultra && x > 30 && x < 52 && y > 15 && y < 40;
      cur[i] = papel ? 225 : fondo + 2;
      const enZona = x >= zx0 && x < zx1 && y >= zy0 && y < zy1;
      if (enZona) {
        total++;
        if (papel) {
          const borde = x === 31 || x === 51 || y === 16 || y === 39;
          marcas[i] = borde ? 2 : 1;
          distintos++;
        }
      }
    }
  }
  const camPct = Math.round((100 * distintos) / Math.max(1, total));
  ws.send(JSON.stringify({
    t: 'depuracion', fase: 'comparando', camPct, movPct: 0, umbral: placa.umbralCamara, corrimiento: 2,
    camVe: camPct >= placa.umbralCamara, refLista: true, refEdadS: Math.round((Date.now() - placa.refDesde) / 1000),
    dist: placa.ultra ? 20.1 : 23.7, vacia: 23.7, ultraUmbral: placa.ultraUmbral, ultraVe: placa.ultra, mano: placa.mano,
    esperando: false, atascado: false, pausa: placa.pausa, vaciar: Boolean(placa.vaciar), servo: placa.servo,
  }));
  ws.send(Buffer.concat([Buffer.from([0x44, w, h, zx0, zx1, zy0, zy1]), ref, cur, marcas]));
}

function inclinar(lado, origen) {
  placa.servo = lado === 'aprovechables' ? 150 : lado === 'no_aprovechables' ? 30 : 90;
  mandarEstado();
  if (origen) ws.send(JSON.stringify({ t: 'movimiento', lado, origen }));
  if (lado === 'nivel') return;
  setTimeout(() => {
    placa.servo = 90;
    placa.ultra = false;
    placa.refDesde = Date.now();
    mandarEstado();
    // como la placa: después de inclinar revisa si el residuo cayó (casi siempre sí)
    const cayo = Math.random() > 0.15;
    // como la placa: lo que midió al revisar (donde estaba el residuo, toda la zona y el ultrasónico)
    ws.send(JSON.stringify({
      t: 'caida', cayo, intentos: cayo ? 1 : 2,
      camResiduo: cayo ? 4 : 86, camZona: cayo ? 1 : 9, cm: cayo ? 23.7 : 21.9, alto: 1.8, vacia: 23.7,
      porCamara: !cayo, porUltra: !cayo,
    }));
  }, 1500);
}

ws.on('open', () => {
  console.log(`Simulador conectado a ${base}`);
  mandarEstado();
  setInterval(() => {
    if (placa.stream) mandarFoto('V');
  }, 250);
  setInterval(() => {
    if (placa.depurar) mandarDepuracion();
  }, 1000);
  setInterval(() => {
    if (placa.pausa || placa.vaciar) return;
    placa.ultra = true;
    mandarEstado();
    setTimeout(() => mandarFoto('C'), 700);
  }, 15000);
});

ws.on('message', (data, esBinario) => {
  if (esBinario) return;
  const m = JSON.parse(data.toString());
  if (m.t === 'stream') {
    placa.stream = m.activo;
    console.log(`Imagen en vivo: ${m.activo ? 'activada' : 'detenida'}`);
  } else if (m.t === 'depurar') {
    placa.depurar = m.activo;
    console.log(`Depuración: ${m.activo ? 'activada' : 'detenida'}`);
  } else if (m.t === 'resultado') {
    console.log(`La IA dijo: ${m.clase}; la bandeja va a ${m.lado}`);
    if (m.clase === 'mano') {
      // no se mueve; la "mano" se va a los 3 s
      placa.mano = true;
      mandarEstado();
      setTimeout(() => {
        placa.mano = false;
        placa.ultra = false;
        mandarEstado();
      }, 3000);
    } else if (m.lado === 'nivel') {
      placa.ultra = false; // vacía: retoma la bandeja vacía
      placa.refDesde = Date.now();
      mandarEstado();
    } else inclinar(m.lado, null);
  } else if (m.t === 'ajustes') {
    placa.umbralCamara = m.umbralCamara;
    placa.zona = m.zona;
    if (Number.isFinite(m.ultraUmbral)) placa.ultraUmbral = m.ultraUmbral;
    if (Number.isFinite(m.flashFoto)) placa.flashFoto = m.flashFoto;
    console.log(`Ajustes: cámara desde ${m.umbralCamara} %, ultrasónico desde ${placa.ultraUmbral} cm, zona ${JSON.stringify(m.zona)}`);
  } else if (m.t === 'orden') {
    console.log(`Orden del monitor: ${m.a}`);
    if (['aprovechables', 'no_aprovechables', 'nivel', 'clasificar'].includes(m.a)) placa.vaciar = null;
    if (m.a === 'vaciar_aprovechables' || m.a === 'vaciar_no_aprovechables') {
      placa.vaciar = m.a.replace('vaciar_', '');
      placa.servo = placa.vaciar === 'aprovechables' ? 160 : 20;
      ws.send(JSON.stringify({ t: 'movimiento', lado: m.a, origen: 'monitor' }));
    } else if (['aprovechables', 'no_aprovechables', 'nivel'].includes(m.a)) inclinar(m.a, 'monitor');
    else if (m.a === 'flash') placa.flash = !placa.flash;
    else if (m.a === 'pausa') placa.pausa = true;
    else if (m.a === 'reanudar') placa.pausa = false;
    else if (m.a === 'referencia' || m.a === 'calibrar') {
      placa.refDesde = Date.now();
      placa.ultra = false;
      setTimeout(() => {
        ws.send(JSON.stringify({ t: 'calibracion', vacia: 23.7, desv: 0.04, validas: 20, medidas: 20, camara: true, foto: true, flash: placa.flashFoto }));
        mandarFoto('R');
      }, 1600);
    }
    else if (m.a === 'clasificar') mandarFoto('B');
    else if (m.a === 'foto_prueba') setTimeout(() => mandarFoto('P'), 400);
    mandarEstado();
  }
});

ws.on('close', (codigo, razon) => {
  console.log(`Desconectado (${codigo}) ${razon || ''}`);
  process.exit(1);
});
ws.on('error', (e) => console.error(`Error: ${e.message}. ¿El servidor está prendido y el TOKEN_DISPOSITIVO coincide?`));
