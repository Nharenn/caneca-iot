// Monitor online de la caneca clasificadora
// - La ESP32-CAM se conecta por WebSocket a /ws/esp (con token) y manda:
//     binario 'V' + JPEG  -> imagen en vivo (solo mientras alguien mira el monitor)
//     binario 'C' + JPEG  -> foto para clasificar (la disparó el ultrasónico o la cámara)
//     binario 'B' + JPEG  -> foto para clasificar (la disparó el botón "Clasificar ahora")
//     binario 'D' + ...   -> depuración: bandeja vacía guardada, lo que ve ahora y qué cambió (miniaturas)
//     texto JSON          -> estado, movimientos, avisos y números de la depuración
// - Los navegadores se conectan a /ws/monitor: reciben imagen y estado. Solo UNA persona maneja la
//   caneca a la vez: la primera que pone el PIN. Las demás miran; si ponen el PIN quedan en fila
//   y el control pasa a la siguiente cuando la primera termina, cierra la página o se queda quieta.
'use strict';

// La página (public/app.js) y el programa de la placa llevan esta misma versión.
// Si no coinciden, el monitor lo avisa (por ejemplo: servidor viejo todavía prendido).
const VERSION = '2026-10-17.5';

const fs = require('fs');
const path = require('path');
// el .env se busca junto a server.js (en el hosting la carpeta de trabajo puede ser otra)
require('dotenv').config({ quiet: true, path: path.join(__dirname, '.env') });
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

// ---------------------------------------------------------------------------
// Configuración (archivo .env o variables de entorno del hosting)
// ---------------------------------------------------------------------------
const CONFIG = {
  // el hosting suele dar el puerto en PORT; en tu computador se usa PUERTO (o 3000)
  puerto: process.env.PORT || Number(process.env.PUERTO) || 3000,
  tokenDispositivo: process.env.TOKEN_DISPOSITIVO || '',
  pinControl: process.env.PIN_CONTROL || '',
  geminiKey: process.env.GEMINI_API_KEY || '',
  modelo: process.env.MODELO_IA || 'gemini-3.1-flash-lite',
  // Si la IA tarda más que esto, se corta y se pregunta otra vez (casi siempre la segunda responde en ~1 s)
  tiempoMaxIA: Math.max(2000, Number(process.env.TIEMPO_MAX_IA_MS) || 5000),
  resolucionBaja: process.env.RESOLUCION_IA !== 'normal',
  modoPrueba: process.env.MODO_PRUEBA === '1' || process.argv.includes('--prueba'),
};

// A qué lado inclina la bandeja cada caneca. Los lados se llaman por la caneca, no izquierda/derecha:
//   aprovechables    = lado del 180 del servo (150°)
//   no_aprovechables = lado del 0 del servo (30°)
//   nivel            = no se mueve (se queda en la bandeja)
const LADOS = ['aprovechables', 'no_aprovechables', 'nivel'];
function normalizarLado(valor) {
  const t = String(valor || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .replace(/[\s-]+/g, '_');
  if (['aprovechables', 'aprovechable', '180'].includes(t)) return 'aprovechables';
  if (['no_aprovechables', 'no_aprovechable', 'noaprovechables', '0'].includes(t)) return 'no_aprovechables';
  return t === 'nivel' ? 'nivel' : null; // los valores viejos (izquierda/derecha) se ignoran
}
function ladoEnv(nombre, porDefecto) {
  return normalizarLado(process.env[nombre]) || porDefecto;
}
const LADO_CANECA = {
  blanca: ladoEnv('LADO_BLANCA', 'aprovechables'),
  verde: ladoEnv('LADO_VERDE', 'no_aprovechables'),
  negra: ladoEnv('LADO_NEGRA', 'no_aprovechables'),
  especial: ladoEnv('LADO_ESPECIAL', 'no_aprovechables'),
  ninguna: 'nivel', // bandeja vacía: no se mueve
};

// Clases que reconoce la caneca: se editan en clases.json, sin tocar el código
const TABLA_CLASES = JSON.parse(fs.readFileSync(path.join(__dirname, 'clases.json'), 'utf8')).clases.filter(
  (c) => /^[a-z]{2,15}$/.test(c.id) && LADO_CANECA[c.caneca] !== undefined,
);
if (!TABLA_CLASES.some((c) => c.id === 'otro')) TABLA_CLASES.push({ id: 'otro', nombre: 'Otro', caneca: 'ninguna', ejemplos: 'no encaja en las demás' });
const CLASE = Object.fromEntries(TABLA_CLASES.map((c) => [c.id, c]));
const CLASES = TABLA_CLASES.map((c) => c.id);
const ORDENES = new Set([
  'aprovechables', 'no_aprovechables', 'nivel',
  'vaciar_aprovechables', 'vaciar_no_aprovechables', // bandeja de canto hacia ese lado, para sacar esa bolsa
  'flash', 'clasificar', 'pausa', 'reanudar',
  'referencia', // guardar ya la foto y la distancia de la bandeja vacía
]);
const MOVIMIENTOS = [...LADOS, 'vaciar_aprovechables', 'vaciar_no_aprovechables', 'vaciar'];
const PROMPT =
  'Mira la foto: es un residuo puesto sobre una bandeja de una caneca en Colombia. ' +
  'Clasifícalo según lo que se ve. Responde solo con UNO de estos códigos, en minúsculas, sin tildes y sin explicar nada:\n' +
  TABLA_CLASES.map((c) => `${c.id}: ${c.ejemplos}`).join('\n') +
  '\nSi un empaque de papel, cartón o plástico está sucio con comida o grasa, responde contaminado. ' +
  'Si no estás seguro, responde otro.';

// ---------------------------------------------------------------------------
// Datos guardados en disco (conteos, historial, ajustes de la cámara, fotos y capturas)
// ---------------------------------------------------------------------------
const DIR_DATOS = path.join(__dirname, 'datos');
const ARCHIVO_DATOS = path.join(DIR_DATOS, 'estado.json');
const ARCHIVO_ULTIMA = path.join(DIR_DATOS, 'ultima.jpg');
const DIR_FOTOS = path.join(DIR_DATOS, 'fotos'); // foto de cada clasificación (las últimas MAX_FOTOS)
const DIR_CAPTURAS = path.join(DIR_DATOS, 'capturas'); // capturas de depuración guardadas desde el monitor
const MAX_EVENTOS = 200;
const MAX_FOTOS = 40;
const MAX_CAPTURAS = 60;
for (const dir of [DIR_DATOS, DIR_FOTOS, DIR_CAPTURAS]) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.error(`No se pudo crear ${dir}:`, e.message);
  }
}

// Detección por cámara: % de la zona que debe cambiar para decir que hay un residuo (1 a 30)
// y la zona de la foto donde está la bandeja, en % (0 a 100)
const UMBRAL_CAMARA_FABRICA = 3;
const ZONA_FABRICA = { x0: 18, x1: 78, y0: 4, y1: 62 };
function umbralValido(valor) {
  const n = Math.round(Number(valor));
  return Number.isFinite(n) ? Math.min(30, Math.max(1, n)) : null;
}
function zonaValida(z) {
  if (!z || typeof z !== 'object') return null;
  const v = ['x0', 'x1', 'y0', 'y1'].map((k) => Math.round(Number(z[k])));
  if (v.some((n) => !Number.isFinite(n) || n < 0 || n > 100)) return null;
  const [x0, x1, y0, y1] = v;
  if (x1 - x0 < 10 || y1 - y0 < 10) return null; // la zona debe medir al menos 10 % por lado
  return { x0, x1, y0, y1 };
}

let datos = {
  conteos: Object.fromEntries(CLASES.map((c) => [c, 0])),
  eventos: [],
  registro: [], // cada clasificación: [fecha en ms, clase, ms de la IA], para las estadísticas
  umbralCamara: UMBRAL_CAMARA_FABRICA,
  zona: { ...ZONA_FABRICA },
};
const MAX_REGISTRO = 20000;
try {
  const guardado = JSON.parse(fs.readFileSync(ARCHIVO_DATOS, 'utf8'));
  datos = {
    conteos: { ...datos.conteos, ...guardado.conteos },
    eventos: Array.isArray(guardado.eventos) ? guardado.eventos : [],
    registro: Array.isArray(guardado.registro) ? guardado.registro : [],
    umbralCamara: umbralValido(guardado.umbralCamara) ?? UMBRAL_CAMARA_FABRICA,
    zona: zonaValida(guardado.zona) ?? { ...ZONA_FABRICA },
  };
} catch {
  /* primera vez: no hay archivo */
}

let temporizadorGuardar = null;
function guardar() {
  clearTimeout(temporizadorGuardar);
  temporizadorGuardar = setTimeout(guardarYa, 500);
}
function guardarYa() {
  clearTimeout(temporizadorGuardar);
  try {
    fs.writeFileSync(ARCHIVO_DATOS, JSON.stringify(datos, null, 2));
  } catch (e) {
    console.error('No se pudo guardar estado.json:', e.message);
  }
}

// Deja solo los 'maximo' archivos más nuevos de una carpeta (los nombres son números crecientes)
function podar(dir, maximo) {
  try {
    const ids = [...new Set(fs.readdirSync(dir).map((f) => f.split('.')[0]).filter((s) => /^\d+$/.test(s)))].sort((a, b) => Number(a) - Number(b));
    for (const id of ids.slice(0, Math.max(0, ids.length - maximo))) {
      for (const f of fs.readdirSync(dir)) if (f.startsWith(`${id}.`)) fs.unlinkSync(path.join(dir, f));
    }
  } catch (e) {
    console.error('No se pudo limpiar', dir, e.message);
  }
}

let contadorIds = Date.now();
function registrarEvento(evento) {
  const completo = { id: evento.id || ++contadorIds, fecha: new Date().toISOString(), ...evento };
  datos.eventos.unshift(completo);
  if (datos.eventos.length > MAX_EVENTOS) datos.eventos.length = MAX_EVENTOS;
  guardar();
  difundir({ t: 'evento', evento: completo, conteos: datos.conteos, estadisticas: estadisticas() });
  return completo;
}

// ---------------------------------------------------------------------------
// Capturas de depuración: lo que veía la caneca en un momento (para revisar errores con calma)
// ---------------------------------------------------------------------------
const TIPOS_CAPTURA = {
  no_detecto: 'No detectó el residuo',
  falsa: 'Detectó sin residuo',
  mal_clasificado: 'Clasificó mal',
  otra: 'Captura',
};
let capturas = []; // resumen de cada una (lo pesado queda en su archivo)
function resumenCaptura(c) {
  const d = c.datos || {};
  return { id: c.id, fecha: c.fecha, tipo: c.tipo, nota: c.nota || '', foto: Boolean(c.foto), camPct: d.camPct ?? null, dist: d.dist ?? null, vacia: d.vacia ?? null };
}
try {
  capturas = fs
    .readdirSync(DIR_CAPTURAS)
    .filter((f) => /^\d+\.json$/.test(f))
    .map((f) => {
      try {
        return resumenCaptura(JSON.parse(fs.readFileSync(path.join(DIR_CAPTURAS, f), 'utf8')));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.id - a.id);
} catch {
  capturas = [];
}

// ---------------------------------------------------------------------------
// Estado en memoria
// ---------------------------------------------------------------------------
let esp = null; // conexión de la ESP32-CAM
let estadoEsp = {
  ultra: false, dist: null, vacia: null, ultraUmbral: null, cam: false, camPct: null, atascado: false, esperando: false,
  pausa: false, vaciar: false, vaciarLado: null, flash: false, servo: 90, rssi: null, ip: null, fw: null, modo: 'online',
};
const monitores = new Set();
let ultimoVideo = null; // última imagen en vivo (JPEG), para las capturas
let ultimaDepuracion = null; // { cuadro: Buffer 'D', numeros: {...}, fecha }
let numerosDepuracion = null;
let depuracionPedida = false;

// Resumen para el panel de análisis: últimas 24 h detalladas y tiempo promedio de la IA
function estadisticas() {
  const desde = Date.now() - 24 * 3600 * 1000;
  const ultimas = datos.registro.filter((r) => r[0] >= desde).map((r) => [r[0], r[1]]);
  const tiempos = datos.registro.slice(-50).map((r) => r[2]).filter((x) => x > 0);
  return {
    ultimas24h: ultimas,
    tiempoIA: tiempos.length ? Math.round(tiempos.reduce((a, b) => a + b, 0) / tiempos.length) : null,
  };
}

function resumen() {
  return {
    version: VERSION,
    online: Boolean(esp),
    estado: estadoEsp,
    conteos: datos.conteos,
    eventos: datos.eventos.slice(0, 30),
    umbralCamara: datos.umbralCamara,
    zona: datos.zona,
    lados: LADO_CANECA,
    clases: TABLA_CLASES.map(({ id, nombre, caneca }) => ({ id, nombre, caneca })),
    estadisticas: estadisticas(),
    capturas: capturas.slice(0, MAX_CAPTURAS),
    tiposCaptura: TIPOS_CAPTURA,
  };
}

function enviar(ws, mensaje) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(mensaje));
}
function enviarEsp(mensaje) {
  enviar(esp, mensaje);
}
function difundir(mensaje) {
  const texto = JSON.stringify(mensaje);
  for (const m of monitores) if (m.readyState === 1) m.send(texto);
}
function actualizarStream() {
  enviarEsp({ t: 'stream', activo: monitores.size > 0 });
}
// La placa solo manda las miniaturas de depuración mientras alguien tiene abierta esa sección
function actualizarDepuracion(forzar) {
  const pedida = [...monitores].some((m) => m.depurando);
  if (pedida !== depuracionPedida || forzar) {
    depuracionPedida = pedida;
    enviarEsp({ t: 'depurar', activo: pedida });
  }
}
function ajustesEsp() {
  return { t: 'ajustes', umbralCamara: datos.umbralCamara, zona: datos.zona };
}

// ---------------------------------------------------------------------------
// Clasificación con Gemini
// ---------------------------------------------------------------------------
function normalizarClase(texto) {
  const t = String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  const palabra = (t.match(/[a-z]+/) || [''])[0];
  if (CLASE[palabra]) return palabra;
  // si respondió con más texto, se queda con la clase más larga que aparezca
  const encontradas = CLASES.filter((c) => t.includes(c)).sort((a, b) => b.length - a.length);
  return encontradas[0] || 'otro';
}

function ladoPara(clase) {
  const c = CLASE[clase];
  return c ? LADO_CANECA[c.caneca] : 'nivel'; // error o desconocido: la bandeja no se mueve
}

async function preguntarIA(jpg) {
  if (CONFIG.modoPrueba) {
    await new Promise((r) => setTimeout(r, 400));
    return CLASES[Math.floor(Math.random() * CLASES.length)];
  }
  if (!CONFIG.geminiKey) throw new Error('Falta GEMINI_API_KEY en el .env o en las variables del hosting');
  const control = new AbortController();
  const limite = setTimeout(() => control.abort(), CONFIG.tiempoMaxIA);
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(CONFIG.modelo)}:generateContent`,
      {
        method: 'POST',
        signal: control.signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': CONFIG.geminiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ inline_data: { mime_type: 'image/jpeg', data: jpg.toString('base64') } }, { text: PROMPT }] }],
          // Baja resolución: ~320 tokens por foto en vez de ~1.150; en la prueba fue más rápido y acertó igual
          ...(CONFIG.resolucionBaja ? { generationConfig: { mediaResolution: 'MEDIA_RESOLUTION_LOW' } } : {}),
        }),
      },
    );
    if (!r.ok) throw new Error(`Gemini respondió ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    const partes = j?.candidates?.[0]?.content?.parts || [];
    return partes.map((p) => p.text || '').join(' ');
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Gemini tardó más de ${CONFIG.tiempoMaxIA / 1000} s (timeout)`);
    throw e;
  } finally {
    clearTimeout(limite);
  }
}

// Si la API está saturada (503/429/500), reintenta hasta 2 veces antes de rendirse
async function preguntarIAConReintentos(jpg) {
  for (let intento = 1; ; intento++) {
    try {
      return await preguntarIA(jpg);
    } catch (e) {
      const temporal = / (429|500|503)/.test(e.message) || e.message.includes('(timeout)');
      if (!temporal || intento >= 3) throw e;
      console.warn(`La API está ocupada (intento ${intento}); reintentando…`);
      await new Promise((r) => setTimeout(r, 1500 * intento));
    }
  }
}

// Las fotos se clasifican una por una, en orden de llegada. Cada foto queda guardada con su evento.
let colaClasificacion = Promise.resolve();
function clasificar(jpg, origen) {
  colaClasificacion = colaClasificacion.then(async () => {
    const id = ++contadorIds;
    let foto = false;
    try {
      fs.writeFileSync(ARCHIVO_ULTIMA, jpg);
      fs.writeFileSync(path.join(DIR_FOTOS, `${id}.jpg`), jpg);
      foto = true;
      podar(DIR_FOTOS, MAX_FOTOS);
    } catch (e) {
      console.error('No se pudo guardar la foto:', e.message);
    }
    let clase;
    let nota;
    let ms;
    try {
      const inicio = Date.now();
      clase = normalizarClase(await preguntarIAConReintentos(jpg));
      ms = Date.now() - inicio;
      console.log(`IA: ${clase} en ${ms} ms`);
    } catch (e) {
      clase = 'error';
      nota = e.message;
      console.error('Clasificación falló:', e.message);
    }
    const lado = ladoPara(clase);
    enviarEsp({ t: 'resultado', clase, lado });
    if (clase !== 'error') {
      datos.conteos[clase] = (datos.conteos[clase] || 0) + 1;
      datos.registro.push([Date.now(), clase, ms || 0]);
      if (datos.registro.length > MAX_REGISTRO) datos.registro.splice(0, datos.registro.length - MAX_REGISTRO);
    }
    registrarEvento({
      id, tipo: 'clasificacion', clase, caneca: CLASE[clase]?.caneca, lado, origen, foto,
      ...(ms ? { ms } : {}), ...(nota ? { nota } : {}),
    });
  });
  return colaClasificacion;
}

// ---------------------------------------------------------------------------
// Mensajes de la ESP32-CAM
// ---------------------------------------------------------------------------
function enviarADepurando(datosBinarios) {
  for (const m of monitores) {
    if (m.depurando && m.readyState === 1 && m.bufferedAmount < 512 * 1024) m.send(datosBinarios, { binary: true });
  }
}

function manejarBinarioEsp(buf) {
  if (buf.length < 4) return;
  const tipo = String.fromCharCode(buf[0]);
  if (tipo === 'D') {
    // [D][ancho][alto][x0][x1][y0][y1] + bandeja vacía + ahora + marcas (cada una ancho*alto bytes)
    const w = buf[1];
    const h = buf[2];
    if (!w || !h || buf.length !== 7 + 3 * w * h) return;
    ultimaDepuracion = { cuadro: Buffer.from(buf), numeros: numerosDepuracion, fecha: Date.now() };
    enviarADepurando(buf);
    return;
  }
  const jpg = buf.subarray(1);
  if (jpg[0] !== 0xff || jpg[1] !== 0xd8) return; // no es un JPEG

  if (tipo === 'V') {
    ultimoVideo = Buffer.from(jpg);
    for (const m of monitores) {
      // si un navegador va lento, se salta imágenes en vez de acumularlas
      if (m.readyState === 1 && m.bufferedAmount < 512 * 1024) m.send(jpg, { binary: true });
    }
  } else if (tipo === 'C' || tipo === 'B') {
    clasificar(Buffer.from(jpg), tipo === 'C' ? 'auto' : 'boton');
  }
}

const num = (v) => (Number.isFinite(v) ? v : null);
function manejarTextoEsp(texto) {
  let m;
  try {
    m = JSON.parse(texto);
  } catch {
    return;
  }
  if (m.t === 'estado') {
    estadoEsp = {
      ultra: Boolean(m.ultra),
      dist: num(m.dist),
      vacia: num(m.vacia),
      ultraUmbral: num(m.ultraUmbral),
      cam: Boolean(m.cam),
      camPct: Number.isFinite(m.camPct) && m.camPct >= 0 ? m.camPct : null,
      atascado: Boolean(m.atascado),
      esperando: Boolean(m.esperando),
      pausa: Boolean(m.pausa),
      vaciar: Boolean(m.vaciar),
      vaciarLado: ['aprovechables', 'no_aprovechables'].includes(m.vaciarLado) ? m.vaciarLado : null,
      flash: Boolean(m.flash),
      servo: Number(m.servo) || 0,
      rssi: m.rssi ?? null,
      ip: typeof m.ip === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(m.ip) && m.ip !== '0.0.0.0' ? m.ip : null,
      fw: typeof m.fw === 'string' ? m.fw.slice(0, 20) : null,
      modo: m.modo || 'online',
    };
    difundir({ t: 'estado', estado: estadoEsp });
  } else if (m.t === 'movimiento') {
    if (MOVIMIENTOS.includes(m.lado)) registrarEvento({ tipo: 'movimiento', lado: m.lado, origen: 'monitor' });
  } else if (m.t === 'aviso' && typeof m.msg === 'string') {
    // por ejemplo: la cámara vio que el residuo no cayó de la bandeja
    registrarEvento({ tipo: 'aviso', msg: m.msg.slice(0, 160) });
  } else if (m.t === 'depuracion') {
    // los números de la depuración (llegan justo antes de cada cuadro 'D')
    const n = {};
    for (const [k, v] of Object.entries(m)) {
      if (k === 't') continue;
      if (typeof v === 'number' || typeof v === 'boolean') n[k] = v;
      else if (typeof v === 'string') n[k] = v.slice(0, 80);
    }
    numerosDepuracion = n;
    const texto2 = JSON.stringify({ t: 'depuracion', ...n });
    for (const mon of monitores) if (mon.depurando && mon.readyState === 1) mon.send(texto2);
  }
}

// ---------------------------------------------------------------------------
// Control: una sola persona maneja la caneca; las demás miran o esperan en fila
// ---------------------------------------------------------------------------
// Si alguien espera su turno y quien maneja no toca nada en este tiempo, el turno pasa al siguiente
const INACTIVIDAD_CONTROL_MS = 3 * 60 * 1000;
let controlador = null; // navegador que maneja la caneca
const fila = []; // navegadores que pusieron el PIN y esperan, en orden de llegada
let ultimaAccionControl = 0;

function infoControl(ws) {
  const puesto = fila.indexOf(ws);
  return {
    t: 'control',
    estado: ws === controlador ? 'tuyo' : puesto >= 0 ? 'espera' : 'mirando',
    puesto: puesto + 1, // 0 = no está en la fila
    ocupado: Boolean(controlador),
    enFila: fila.length,
    mirando: monitores.size,
  };
}
function avisarControl() {
  for (const m of monitores) enviar(m, infoControl(m));
}
function darControl(ws) {
  controlador = ws;
  ultimaAccionControl = Date.now();
}
// Quien maneja termina (o se va): el control pasa al primero de la fila
function soltarControl(ws, motivo) {
  if (ws === controlador) {
    controlador = null;
    if (motivo) enviar(ws, { t: 'error', msg: motivo });
    const siguiente = fila.shift();
    if (siguiente) {
      darControl(siguiente);
      enviar(siguiente, { t: 'ok', msg: 'Es tu turno: ya tienes el control de la caneca.' });
    }
  } else {
    const i = fila.indexOf(ws);
    if (i >= 0) fila.splice(i, 1);
  }
  avisarControl();
}
function pedirControl(ws, pin) {
  if (ws === controlador || fila.includes(ws)) return enviar(ws, infoControl(ws));
  if (!pinValido(ws, pin)) return;
  if (!controlador) {
    darControl(ws);
    enviar(ws, { t: 'ok', msg: 'Tienes el control. Los demás solo pueden mirar.' });
  } else {
    fila.push(ws);
    enviar(ws, { t: 'ok', msg: `Otra persona está manejando la caneca. Estás en la fila (puesto ${fila.length}).` });
  }
  avisarControl();
}
// Las órdenes solo valen de quien tiene el control
function tieneControl(ws) {
  if (ws === controlador) {
    ultimaAccionControl = Date.now();
    return true;
  }
  enviar(ws, {
    t: 'error',
    msg: fila.includes(ws) ? 'Espera tu turno: otra persona está manejando la caneca.' : 'Primero toma el control con el PIN.',
  });
  return false;
}
function revisarInactividad() {
  if (controlador && fila.length && Date.now() - ultimaAccionControl > INACTIVIDAD_CONTROL_MS) {
    soltarControl(controlador, 'Pasaron 3 minutos sin que tocaras nada y alguien esperaba: el control pasó a la siguiente persona.');
  }
}

function pinValido(ws, pin) {
  if (!CONFIG.pinControl) {
    enviar(ws, { t: 'error', msg: 'El servidor no tiene PIN_CONTROL configurado.' });
    return false;
  }
  if (ws.bloqueadoHasta && Date.now() < ws.bloqueadoHasta) {
    enviar(ws, { t: 'error', msg: 'Demasiados intentos con PIN incorrecto. Espera un minuto.' });
    return false;
  }
  if (String(pin || '') === CONFIG.pinControl) {
    ws.intentosPin = 0;
    return true;
  }
  ws.intentosPin = (ws.intentosPin || 0) + 1;
  if (ws.intentosPin >= 5) {
    ws.bloqueadoHasta = Date.now() + 60000;
    ws.intentosPin = 0;
  }
  enviar(ws, { t: 'error', msg: 'PIN incorrecto.' });
  return false;
}

// Guarda lo que la caneca está viendo ahora (miniaturas + números + foto en vivo)
function guardarCaptura(ws, m) {
  if (!ultimaDepuracion || Date.now() - ultimaDepuracion.fecha > 15000) {
    return enviar(ws, { t: 'error', msg: 'Todavía no hay imagen de depuración: con "Depuración paso a paso" abierta, espera a que salgan las tres imágenes.' });
  }
  const id = ++contadorIds;
  const tipo = TIPOS_CAPTURA[m.tipo] ? m.tipo : 'otra';
  const registro = {
    id,
    fecha: new Date().toISOString(),
    tipo,
    nota: String(m.nota || '').slice(0, 200),
    datos: ultimaDepuracion.numeros || {},
    cuadro: ultimaDepuracion.cuadro.toString('base64'),
    foto: Boolean(ultimoVideo),
  };
  try {
    fs.writeFileSync(path.join(DIR_CAPTURAS, `${id}.json`), JSON.stringify(registro));
    if (ultimoVideo) fs.writeFileSync(path.join(DIR_CAPTURAS, `${id}.jpg`), ultimoVideo);
    podar(DIR_CAPTURAS, MAX_CAPTURAS);
  } catch (e) {
    return enviar(ws, { t: 'error', msg: `No se pudo guardar la captura: ${e.message}` });
  }
  capturas = [resumenCaptura(registro), ...capturas].slice(0, MAX_CAPTURAS);
  registrarEvento({ tipo: 'captura', capturaId: id, capturaTipo: tipo, nota: registro.nota });
  difundir({ t: 'capturas', lista: capturas });
  if (m.clasificar) {
    if (!esp) return enviar(ws, { t: 'error', msg: 'Captura guardada, pero la caneca no está conectada para clasificar.' });
    enviarEsp({ t: 'orden', a: 'clasificar' });
    return enviar(ws, { t: 'ok', msg: 'Captura guardada y foto enviada a la IA.' });
  }
  enviar(ws, { t: 'ok', msg: 'Captura guardada: está en la lista de abajo para revisarla.' });
}

function manejarMonitor(ws, texto) {
  let m;
  try {
    m = JSON.parse(texto);
  } catch {
    return;
  }
  if (m.t === 'pedirControl') {
    pedirControl(ws, m.pin);
  } else if (m.t === 'soltarControl') {
    soltarControl(ws);
  } else if (m.t === 'depurar') {
    ws.depurando = Boolean(m.activo); // mirar la depuración no necesita el control
    actualizarDepuracion();
    if (ws.depurando && numerosDepuracion) enviar(ws, { t: 'depuracion', ...numerosDepuracion });
    if (ws.depurando && ultimaDepuracion) ws.send(ultimaDepuracion.cuadro, { binary: true });
  } else if (m.t === 'orden') {
    if (!ORDENES.has(m.a) || !tieneControl(ws)) return;
    if (!esp) return enviar(ws, { t: 'error', msg: 'La caneca no está conectada.' });
    enviarEsp({ t: 'orden', a: m.a });
    enviar(ws, { t: 'ok', msg: 'Orden enviada.' });
  } else if (m.t === 'captura') {
    if (!tieneControl(ws)) return;
    guardarCaptura(ws, m);
  } else if (m.t === 'reiniciar') {
    if (!tieneControl(ws)) return;
    datos.conteos = Object.fromEntries(CLASES.map((c) => [c, 0]));
    datos.registro = [];
    datos.eventos = [];
    guardarYa();
    difundir({ t: 'resumen', ...resumen() });
    enviar(ws, { t: 'ok', msg: 'Estadísticas reiniciadas.' });
  } else if (m.t === 'ajustes') {
    // solo la detección por cámara (los ángulos del servo ya están fijos en la placa)
    if (!tieneControl(ws)) return;
    const umbralCamara = umbralValido(m.umbralCamara);
    const zona = zonaValida(m.zona);
    if (umbralCamara === null) return enviar(ws, { t: 'error', msg: 'El % de la cámara debe ser un número de 1 a 30.' });
    if (zona === null) return enviar(ws, { t: 'error', msg: 'Revisa la zona: de 0 a 100 %, y al menos 10 % entre el inicio y el fin.' });
    datos.umbralCamara = umbralCamara;
    datos.zona = zona;
    guardar();
    enviarEsp(ajustesEsp());
    difundir({ t: 'ajustes', umbralCamara, zona });
    enviar(ws, { t: 'ok', msg: 'Ajustes de la cámara guardados.' });
  }
}

// ---------------------------------------------------------------------------
// Servidor HTTP + WebSockets
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/resumen', (_req, res) => res.json(resumen()));

// Para revisar el hosting desde el navegador: /api/salud (no muestra claves, solo si están puestas)
app.get('/api/salud', (_req, res) =>
  res.json({
    ok: true,
    version: VERSION,
    online: Boolean(esp),
    monitores: monitores.size,
    config: {
      token: Boolean(CONFIG.tokenDispositivo),
      pin: Boolean(CONFIG.pinControl),
      ia: CONFIG.modoPrueba ? 'prueba (al azar)' : `gemini (${CONFIG.modelo})`,
      claveIA: Boolean(CONFIG.geminiKey),
      lados: LADO_CANECA,
    },
  }),
);

function enviarJpg(res, archivo) {
  if (!fs.existsSync(archivo)) return res.status(404).end();
  res.set('Cache-Control', 'no-store');
  res.sendFile(archivo);
}
app.get('/ultima.jpg', (_req, res) => enviarJpg(res, ARCHIVO_ULTIMA));
app.get('/fotos/:id.jpg', (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(404).end();
  enviarJpg(res, path.join(DIR_FOTOS, `${req.params.id}.jpg`));
});
app.get('/api/capturas', (_req, res) => res.json({ capturas, tipos: TIPOS_CAPTURA }));
app.get('/api/capturas/:id', (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(404).end();
  const archivo = path.join(DIR_CAPTURAS, `${req.params.id}.json`);
  if (!fs.existsSync(archivo)) return res.status(404).json({ error: 'No existe esa captura.' });
  res.set('Cache-Control', 'no-store');
  res.type('application/json').send(fs.readFileSync(archivo));
});
app.get('/capturas/:id.jpg', (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(404).end();
  enviarJpg(res, path.join(DIR_CAPTURAS, `${req.params.id}.jpg`));
});

const servidor = http.createServer(app);
const wssEsp = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
const wssMonitor = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

servidor.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/ws/esp') {
    if (!CONFIG.tokenDispositivo || url.searchParams.get('token') !== CONFIG.tokenDispositivo) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wssEsp.handleUpgrade(req, socket, head, (ws) => wssEsp.emit('connection', ws, req));
  } else if (url.pathname === '/ws/monitor') {
    wssMonitor.handleUpgrade(req, socket, head, (ws) => wssMonitor.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wssEsp.on('connection', (ws) => {
  if (esp && esp !== ws) esp.close(4000, 'Otra conexión de la caneca la reemplazó');
  esp = ws;
  ws.vivo = true;
  console.log('Caneca conectada');
  ws.on('pong', () => (ws.vivo = true));
  ws.on('message', (data, esBinario) => (esBinario ? manejarBinarioEsp(data) : manejarTextoEsp(data.toString())));
  ws.on('close', () => {
    if (esp === ws) {
      esp = null;
      console.log('Caneca desconectada');
      difundir({ t: 'online', valor: false });
    }
  });
  enviarEsp(ajustesEsp());
  actualizarStream();
  actualizarDepuracion(true);
  difundir({ t: 'online', valor: true });
});

wssMonitor.on('connection', (ws) => {
  monitores.add(ws);
  ws.vivo = true;
  ws.on('pong', () => (ws.vivo = true));
  ws.on('message', (data, esBinario) => {
    if (!esBinario) manejarMonitor(ws, data.toString());
  });
  ws.on('close', () => {
    monitores.delete(ws);
    soltarControl(ws); // si manejaba, el control pasa al siguiente; si esperaba, sale de la fila
    actualizarStream();
    actualizarDepuracion();
  });
  enviar(ws, { t: 'resumen', ...resumen() });
  avisarControl(); // a todos: cambió cuántos miran
  actualizarStream();
});

// Cierra conexiones muertas (sin respuesta al ping en 30 s) y revisa el turno del control
const latido = setInterval(() => {
  revisarInactividad();
  for (const ws of [...wssEsp.clients, ...wssMonitor.clients]) {
    if (!ws.vivo) {
      ws.terminate();
      continue;
    }
    ws.vivo = false;
    ws.ping();
  }
}, 30000);

servidor.listen(CONFIG.puerto, () => {
  console.log(`Monitor de la caneca (versión ${VERSION}) en el puerto ${CONFIG.puerto} (en tu computador: http://localhost:${CONFIG.puerto})`);
  if (!CONFIG.tokenDispositivo) console.warn('Aviso: falta TOKEN_DISPOSITIVO; la caneca no podrá conectarse.');
  if (!CONFIG.pinControl) console.warn('Aviso: falta PIN_CONTROL; nadie podrá tomar el control del monitor.');
  if (!CONFIG.geminiKey && !CONFIG.modoPrueba) console.warn('Aviso: falta GEMINI_API_KEY; la clasificación va a fallar.');
  if (CONFIG.modoPrueba) console.warn('MODO_PRUEBA=1: la clasificación es al azar, no se usa la API de IA.');
});

function apagar() {
  clearInterval(latido);
  guardarYa();
  process.exit(0);
}
process.on('SIGINT', apagar);
process.on('SIGTERM', apagar);
